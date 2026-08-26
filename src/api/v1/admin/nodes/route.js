const crypto = require('crypto');
const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function generateNodeId() {
    return 'node_' + crypto.randomBytes(8).toString('hex');
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NODES_GET', 40, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const nodes = await db.collection('nodes').find({}).toArray();
            const locations = await db.collection('locations').find({}).toArray();
            const allocations = await db.collection('allocations').find({}).toArray();
            const servers = await db.collection('servers').find({}).toArray();

            const locMap = {};
            locations.forEach(loc => {
                locMap[loc.id] = loc;
            });

            const allocCounts = {};
            allocations.forEach(alloc => {
                allocCounts[alloc.nodeId] = (allocCounts[alloc.nodeId] || 0) + 1;
            });

            const serverCounts = {};
            servers.forEach(srv => {
                serverCounts[srv.nodeId] = (serverCounts[srv.nodeId] || 0) + 1;
            });

            const formattedNodes = await Promise.all(nodes.map(async (n) => {
                let isOnline = false;
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2000);
                    const pingRes = await fetch(`https://${n.fqdn}:${n.daemonPort || 8080}/test`, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${n.daemonKey}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (pingRes.ok || pingRes.status === 200 || pingRes.status === 401 || pingRes.status === 403) {
                        isOnline = true;
                    }
                } catch (e) {
                    isOnline = false;
                }

                return {
                    id: n.id || n._id.toString(),
                    name: n.name,
                    locationId: n.locationId,
                    locationName: locMap[n.locationId]?.name || 'Unknown',
                    locationFlag: locMap[n.locationId]?.flag || 'US',
                    fqdn: n.fqdn,
                    scheme: 'https',
                    daemonPort: n.daemonPort || 8080,
                    uploadSize: n.uploadSize || 100,
                    maintenanceMode: n.maintenanceMode === true,
                    isOnline,
                    allocationCount: allocCounts[n.id] || 0,
                    serverCount: serverCounts[n.id] || 0,
                    createdAt: n.createdAt
                };
            }));

            return reply.status(200).send({ nodes: formattedNodes });
        } catch (err) {
            console.error('[Admin Nodes GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },

    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NODES_CREATE', 10, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const { name, locationId, fqdn, daemonPort, uploadSize, maintenanceMode } = req.body || {};

            if (!name || typeof name !== 'string' || !name.trim()) {
                return reply.status(400).send({ error: 'Node name is required.' });
            }
            if (!locationId || typeof locationId !== 'string') {
                return reply.status(400).send({ error: 'Location assignment is required.' });
            }
            if (!fqdn || typeof fqdn !== 'string' || !fqdn.trim()) {
                return reply.status(400).send({ error: 'Valid FQDN is required (e.g. node1.example.com).' });
            }

            const locationExists = await db.collection('locations').findOne({ id: locationId });
            if (!locationExists) {
                return reply.status(400).send({ error: 'Assigned location does not exist.' });
            }

            const parsedPort = parseInt(daemonPort, 10) || 8080;
            const parsedUpload = parseInt(uploadSize, 10) || 100;

            const nodeId = generateNodeId();
            const daemonKey = crypto.randomBytes(32).toString('hex');

            const newNode = {
                id: nodeId,
                name: name.trim(),
                locationId,
                fqdn: fqdn.trim().toLowerCase(),
                scheme: 'https',
                daemonPort: parsedPort,
                uploadSize: parsedUpload,
                maintenanceMode: maintenanceMode === true,
                daemonKey,
                createdAt: new Date().toISOString()
            };

            await db.collection('nodes').insertOne(newNode);

            return reply.status(201).send({
                success: true,
                message: 'Node created successfully.',
                nodeId: newNode.id
            });
        } catch (err) {
            console.error('[Admin Nodes POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },

    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NODES_DELETE', 10, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const { id } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Node ID is required.' });
            }

            const activeServers = await db.collection('servers').countDocuments({ nodeId: id });
            if (activeServers > 0) {
                return reply.status(400).send({ error: `Cannot delete node: ${activeServers} active server(s) are attached to this node.` });
            }

            const result = await db.collection('nodes').deleteOne({ id });
            if (result.deletedCount === 0) {
                return reply.status(404).send({ error: 'Node not found.' });
            }
            await db.collection('allocations').deleteMany({ nodeId: id });

            return reply.status(200).send({ success: true, message: 'Node and its unassigned allocations deleted.' });
        } catch (err) {
            console.error('[Admin Nodes DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
