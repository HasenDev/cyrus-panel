const { getDB } = require('../../../../../lib/db');
const { authenticate } = require('../../../../../lib/auth');
const { getPermissions } = require('../../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../../lib/rateLimit');

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NODE_MANAGE_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const nodeId = req.query.nodeId || req.query.id;
            if (!nodeId) {
                return reply.status(400).send({ error: 'Node ID is required.' });
            }

            const node = await db.collection('nodes').findOne({ id: nodeId });
            if (!node) {
                return reply.status(404).send({ error: 'Node not found.' });
            }

            const locations = await db.collection('locations').find({}).toArray();
            const allocationCount = await db.collection('allocations').countDocuments({ nodeId });

            const location = locations.find(l => l.id === node.locationId) || null;

            let isOnline = false;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2500);
                
                const pingRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/test`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${node.daemonKey}`
                    },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (pingRes.ok || pingRes.status === 200 || pingRes.status === 401 || pingRes.status === 403) {
                    isOnline = true;
                }
            } catch {
                isOnline = false;
            }

            const serverPage = Math.max(1, parseInt(req.query.serverPage || req.query.page, 10) || 1);
            const serverLimit = Math.max(1, parseInt(req.query.serverLimit || req.query.limit, 10) || 10);
            
            const totalServers = await db.collection('servers').countDocuments({ nodeId });
            const totalServerPages = Math.ceil(totalServers / serverLimit) || 1;
            const skip = (serverPage - 1) * serverLimit;

            const serverDocs = await db.collection('servers')
                .find({ nodeId })
                .skip(skip)
                .limit(serverLimit)
                .toArray();

            const primaryAllocIds = serverDocs.map(s => s.allocationId).filter(Boolean);
            const allocations = await db.collection('allocations').find({
                id: { $in: primaryAllocIds }
            }).toArray();

            const servers = serverDocs.map(s => {
                const primaryAlloc = allocations.find(a => a.id === s.allocationId);
                const allocStr = primaryAlloc ? `${primaryAlloc.ip}:${primaryAlloc.port}` : 'Unassigned';

                return {
                    id: s.id || s._id.toString(),
                    name: s.name,
                    description: s.description || '',
                    ownerUsername: s.ownerUsername || 'System',
                    nodeId: s.nodeId,
                    nodeName: node.name,
                    allocation: allocStr,
                    memory: s.memory || 0,
                    disk: s.disk || 0,
                    cpu: s.cpu || 0,
                    priceCredits: s.priceCredits || 0,
                    createdAt: s.createdAt
                };
            });

            return reply.status(200).send({
                node: {
                    id: node.id,
                    name: node.name,
                    locationId: node.locationId,
                    locationName: location ? location.name : 'Unknown',
                    locationFlag: location ? location.flag : 'US',
                    fqdn: node.fqdn,
                    scheme: 'https',
                    daemonPort: node.daemonPort || 8080,
                    uploadSize: node.uploadSize || 100,
                    maintenanceMode: node.maintenanceMode === true,
                    daemonKey: node.daemonKey,
                    isOnline,
                    allocationCount,
                    totalServers,
                    createdAt: node.createdAt
                },
                locations: locations.map(l => ({ id: l.id, name: l.name, flag: l.flag })),
                servers,
                serverPagination: {
                    page: serverPage,
                    limit: serverLimit,
                    totalPages: totalServerPages,
                    total: totalServers
                }
            });
        } catch (err) {
            console.error('[Admin Manage Node GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NODE_MANAGE_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const { id, name, locationId, fqdn, daemonPort, uploadSize, maintenanceMode } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Node ID is required.' });
            }

            const updateFields = { scheme: 'https' };

            if (typeof name === 'string' && name.trim()) updateFields.name = name.trim();
            if (typeof locationId === 'string' && locationId.trim()) updateFields.locationId = locationId.trim();
            if (typeof fqdn === 'string' && fqdn.trim()) updateFields.fqdn = fqdn.trim().toLowerCase();

            if (daemonPort !== undefined) updateFields.daemonPort = parseInt(daemonPort, 10) || 8080;
            if (uploadSize !== undefined) updateFields.uploadSize = parseInt(uploadSize, 10) || 100;
            if (maintenanceMode !== undefined) updateFields.maintenanceMode = Boolean(maintenanceMode);

            const result = await db.collection('nodes').updateOne(
                { id },
                { $set: updateFields }
            );

            if (result.matchedCount === 0) {
                return reply.status(404).send({ error: 'Node not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Node settings updated.' });
        } catch (err) {
            console.error('[Admin Manage Node PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};