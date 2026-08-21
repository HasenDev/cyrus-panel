const { getDB } = require('../../../../../lib/db');
const { authenticate } = require('../../../../../lib/auth');
const { getPermissions } = require('../../../../../lib/getPermissions');

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SERVERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SERVERS permission.' });
            }

            const nests = await db.collection('nests').find({}).toArray();
            const eggs = await db.collection('eggs').find({}).toArray();
            const nodes = await db.collection('nodes').find({}).toArray();
            const unassignedAllocations = await db.collection('allocations')
                .find({ assignedServerId: null })
                .toArray();

            return reply.status(200).send({
                nests: nests.map(n => ({ id: n.id, name: n.name })),
                eggs: eggs.map(e => ({
                    id: e.id,
                    nestId: e.nestId,
                    name: e.name,
                    docker_images: e.docker_images || {},
                    startup: e.startup || '',
                    variables: e.variables || []
                })),
                nodes: nodes.map(n => ({
                    id: n.id,
                    name: n.name,
                    fqdn: n.fqdn,
                    maintenanceMode: Boolean(n.maintenanceMode)
                })),
                allocations: unassignedAllocations.map(a => ({
                    id: a.id,
                    nodeId: a.nodeId,
                    ip: a.ip,
                    port: a.port
                }))
            });
        } catch (err) {
            console.error('[Admin Server Create-Info GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};