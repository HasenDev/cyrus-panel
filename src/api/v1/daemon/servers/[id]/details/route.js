const { getDB } = require('../../../../../../lib/db');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');

module.exports = {
    GET: async (req, reply) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) return reply.status(401).send({ error: 'Daemon key required.' });

            let daemonKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

            const db = getDB();
            const node = await db.collection('nodes').findOne({ daemonKey });
            if (!node) return reply.status(401).send({ error: 'Invalid daemon key.' });

            if (checkRateLimit(reply, node.id, 'DAEMON_SERVER_DETAILS_GET', 120, 60000)) return;

            const serverId = req.params?.id || req.query?.serverId;
            const server = await db.collection('servers').findOne({ id: serverId, nodeId: node.id });
            if (!server) return reply.status(404).send({ error: 'Server not found.' });

            const egg = await db.collection('eggs').findOne({ id: server.eggId });
            const allocations = await db.collection('allocations').find({ nodeId: node.id }).toArray();

            const primaryAlloc = allocations.find(a => a.id === server.allocationId) || null;
            const additionalAllocs = allocations.filter(a =>
                Array.isArray(server.additionalAllocationIds) && server.additionalAllocationIds.includes(a.id)
            );

            return reply.status(200).send({
                uuid: server.id,
                name: server.name,
                suspended: Boolean(server.suspended),
                ownerId: server.ownerId,
                startup: server.startup || (egg ? egg.startup : ''),
                build: {
                    memoryLimit: server.memory || 1024,
                    cpuLimit: server.cpu || 100,
                    diskLimit: server.disk || 5000
                },
                allocations: {
                    primary: primaryAlloc ? { id: primaryAlloc.id, ip: primaryAlloc.ip, port: primaryAlloc.port } : null,
                    additional: additionalAllocs.map(a => ({ id: a.id, ip: a.ip, port: a.port }))
                },
                docker: {
                    image: server.dockerImage || 'ubuntu:latest',
                    env: server.env || {}
                },
                eggScripts: server.eggScript || (egg ? egg.scripts : {})
            });
        } catch (err) {
            console.error('[Daemon Server Details Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
