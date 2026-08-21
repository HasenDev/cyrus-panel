const { getDB } = require('../../../../lib/db');

async function authenticateDaemon(req, reply) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return reply.status(401).send({ error: 'Daemon authorization token required.' });

    let token = authHeader;
    if (token.startsWith('Bearer ')) token = token.slice(7);

    const db = getDB();
    const node = await db.collection('nodes').findOne({ daemonKey: token });

    if (!node) {
        return reply.status(401).send({ error: 'Invalid daemon authentication key.' });
    }

    req.node = node;
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticateDaemon(req, reply);
            if (reply.sent) return;

            const db = getDB();
            const node = req.node;

            const servers = await db.collection('servers').find({ nodeId: node.id }).toArray();
            const allocations = await db.collection('allocations').find({ nodeId: node.id }).toArray();
            const pendingDeletions = await db.collection('pending_deletions').find({ nodeId: node.id }).toArray();

            const responseServers = servers.map(s => {
                const primaryAlloc = allocations.find(a => a.id === s.allocationId) || null;
                const additionalAllocs = allocations.filter(a =>
                    Array.isArray(s.additionalAllocationIds) && s.additionalAllocationIds.includes(a.id)
                );

                return {
                    uuid: s.id,
                    name: s.name,
                    suspended: Boolean(s.suspended),
                    installing: Boolean(s.installing),
                    ownerId: s.ownerId,
                    startup: s.startup || '',
                    build: {
                        memoryLimit: s.memory || 1024,
                        cpuLimit: s.cpu || 100,
                        diskLimit: s.disk || 5000
                    },
                    allocations: {
                        primary: primaryAlloc ? { id: primaryAlloc.id, ip: primaryAlloc.ip, port: primaryAlloc.port } : null,
                        additional: additionalAllocs.map(a => ({ id: a.id, ip: a.ip, port: a.port }))
                    },
                    docker: {
                        image: s.dockerImage || 'ubuntu:latest',
                        env: s.env || {}
                    }
                };
            });

            return reply.status(200).send({
                nodeId: node.id,
                serverCount: responseServers.length,
                servers: responseServers,
                pendingDeletions: pendingDeletions.map(p => p.uuid)
            });
        } catch (err) {
            console.error('[Daemon Servers GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticateDaemon(req, reply);
            if (reply.sent) return;

            const db = getDB();
            const { clearedDeletions } = req.body || {};

            if (Array.isArray(clearedDeletions) && clearedDeletions.length > 0) {
                await db.collection('pending_deletions').deleteMany({
                    nodeId: req.node.id,
                    uuid: { $in: clearedDeletions }
                });
            }

            return reply.status(200).send({
                success: true,
                message: 'Pending deletions acknowledged and cleared.'
            });
        } catch (err) {
            console.error('[Daemon Servers ACK POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};