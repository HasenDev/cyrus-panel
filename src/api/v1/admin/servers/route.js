const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');
const { validateDockerImage, buildAndValidateEnv } = require('../../../../lib/variableValidator');

function generateServerId() {
    return 'srv_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SERVERS_GET', 40, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SERVERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SERVERS permission.' });
            }

            const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
            const limit = Math.max(1, Math.min(100, parseInt(req.query?.limit, 10) || 10));
            const search = String(req.query?.search || '').trim();

            let filter = {};
            if (search) {
                filter = {
                    $or: [
                        { name: { $regex: search, $options: 'i' } },
                        { id: { $regex: search, $options: 'i' } },
                        { ownerUsername: { $regex: search, $options: 'i' } }
                    ]
                };
            }

            const totalServers = await db.collection('servers').countDocuments(filter);
            const totalPages = Math.max(1, Math.ceil(totalServers / limit));
            const actualPage = page > totalPages ? totalPages : page;
            const skip = (actualPage - 1) * limit;

            const servers = await db.collection('servers')
                .find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            const nodes = await db.collection('nodes').find({}).toArray();
            const allocations = await db.collection('allocations').find({}).toArray();

            const formattedServers = await Promise.all(servers.map(async (s) => {
                const node = nodes.find(n => n.id === s.nodeId);
                const alloc = allocations.find(a => a.id === s.allocationId);

                let liveStatus = s.installing ? 'installing' : (s.status || 'offline');

                if (!s.installing && node && !node.maintenanceMode) {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 1500);
                        const statusRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${s.id}`, {
                            method: 'GET',
                            headers: { 'Authorization': `Bearer ${node.daemonKey}` },
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);

                        if (statusRes.ok) {
                            const statusData = await statusRes.json();
                            liveStatus = statusData.status || liveStatus;
                        } else {
                            liveStatus = 'offline';
                        }
                    } catch {
                        liveStatus = 'offline';
                    }
                }

                return {
                    id: s.id || s._id.toString(),
                    name: s.name,
                    description: s.description || '',
                    ownerId: s.ownerId,
                    ownerUsername: s.ownerUsername || 'Unknown',
                    nodeId: s.nodeId,
                    nodeName: node ? node.name : 'Unknown',
                    allocation: alloc ? `${alloc.ip}:${alloc.port}` : 'Unassigned',
                    memory: s.memory || 1024,
                    disk: s.disk || 5000,
                    cpu: s.cpu || 100,
                    priceCredits: s.priceCredits || 0,
                    maxAllocations: Math.min(50, Math.max(0, parseInt(s.maxAllocations, 10) || 0)),
                    installing: Boolean(s.installing),
                    status: liveStatus,
                    createdAt: s.createdAt
                };
            }));

            return reply.status(200).send({
                servers: formattedServers,
                pagination: {
                    total: totalServers,
                    totalPages: totalPages,
                    currentPage: actualPage,
                    limit: limit
                }
            });
        } catch (err) {
            console.error('[Admin Servers GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },

    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SERVERS_CREATE', 10, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SERVERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SERVERS permission.' });
            }

            const {
                name,
                description,
                ownerId,
                nodeId,
                allocationId,
                additionalAllocationIds = [],
                nestId,
                eggId,
                dockerImage,
                startup,
                environment = {},
                memory,
                disk,
                cpu,
                priceCredits,
                maxAllocations = 0
            } = req.body || {};

            if (!name || !ownerId || !nodeId || !allocationId || !nestId || !eggId) {
                return reply.status(400).send({ error: 'Name, Owner, Node, Primary Allocation, Nest, and Egg are required.' });
            }

            const owner = await db.collection('users').findOne({ _id: ownerId });
            if (!owner) return reply.status(404).send({ error: 'Selected server owner not found.' });

            const node = await db.collection('nodes').findOne({ id: nodeId });
            if (!node) return reply.status(404).send({ error: 'Selected node not found.' });

            const primaryAlloc = await db.collection('allocations').findOne({ id: allocationId, nodeId, assignedServerId: null });
            if (!primaryAlloc) {
                return reply.status(400).send({ error: 'Primary allocation is invalid or already assigned.' });
            }

            const egg = await db.collection('eggs').findOne({ id: eggId, nestId });
            if (!egg) return reply.status(404).send({ error: 'Selected egg template not found.' });
            const imageCandidate = dockerImage || Object.values(egg.docker_images || {})[0] || egg.docker_image || 'ubuntu:latest';
            const imgValidation = validateDockerImage(egg, imageCandidate);
            if (!imgValidation.valid) {
                return reply.status(400).send({ error: imgValidation.error });
            }
            const selectedImage = imgValidation.image;
            const envValidation = buildAndValidateEnv(egg.variables, environment, false);
            if (!envValidation.valid) {
                return reply.status(422).send({
                    error: envValidation.error,
                    variable: envValidation.variable
                });
            }
            const finalEnv = envValidation.env;

            const serverId = generateServerId();
            const selectedStartup = startup || egg.startup || '';
            const sanitizedMaxAllocations = Math.min(50, Math.max(0, parseInt(maxAllocations, 10) || 0));

            const serverPayload = {
                id: serverId,
                name: name.trim(),
                description: String(description || '').trim(),
                ownerId: owner._id,
                ownerUsername: owner.username,
                nodeId,
                allocationId,
                additionalAllocationIds,
                nestId,
                eggId,
                dockerImage: selectedImage,
                startup: selectedStartup,
                env: finalEnv,
                memory: Math.max(128, parseInt(memory, 10) || 1024),
                disk: Math.max(512, parseInt(disk, 10) || 5000),
                cpu: Math.max(10, parseInt(cpu, 10) || 100),
                priceCredits: Math.max(0, parseInt(priceCredits, 10) || 0),
                maxAllocations: sanitizedMaxAllocations,
                installing: true,
                status: 'installing',
                eggScript: egg.scripts || {},
                allocations: {
                    primary: { ip: primaryAlloc.ip, port: primaryAlloc.port },
                    additional: []
                },
                createdAt: new Date().toISOString()
            };

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);

                const daemonRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${node.daemonKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(serverPayload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const daemonData = await daemonRes.json();

                if (!daemonRes.ok || !daemonData.success) {
                    return reply.status(400).send({
                        error: `Node Daemon Creation Failed: ${daemonData.error || 'Daemon rejected container creation.'}`
                    });
                }
            } catch (err) {
                return reply.status(502).send({
                    error: `Node Daemon Unreachable: Could not connect to node ${node.name} (${node.fqdn}).`
                });
            }

            await db.collection('servers').insertOne(serverPayload);

            const allAllocIds = [allocationId, ...additionalAllocationIds];
            await db.collection('allocations').updateMany(
                { id: { $in: allAllocIds } },
                { $set: { assignedServerId: serverId, assignedServerName: serverPayload.name } }
            );

            return reply.status(201).send({
                success: true,
                message: 'Server created successfully.',
                serverId
            });
        } catch (err) {
            console.error('[Admin Server Create POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};