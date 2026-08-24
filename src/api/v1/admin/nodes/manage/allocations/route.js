const net = require('net');
const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { getPermissions } = require('../../../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');

function generateAllocId() {
    return 'alloc_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ALLOCATIONS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const nodeId = req.query.nodeId;
            if (!nodeId) return reply.status(400).send({ error: 'Node ID is required.' });

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));
            const skip = (page - 1) * limit;

            const total = await db.collection('allocations').countDocuments({ nodeId });
            const allocations = await db.collection('allocations')
                .find({ nodeId })
                .sort({ ip: 1, port: 1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            return reply.status(200).send({
                allocations: allocations.map(a => ({
                    id: a.id || a._id.toString(),
                    ip: a.ip,
                    port: a.port,
                    assignedServerId: a.assignedServerId || null,
                    assignedServerName: a.assignedServerName || null
                })),
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit) || 1
                }
            });
        } catch (err) {
            console.error('[Admin Allocations GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ALLOCATIONS_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const { nodeId, ip, ports } = req.body || {};
            if (!nodeId || !ip || !ports) {
                return reply.status(400).send({ error: 'Node ID, IP address, and Ports input are required.' });
            }

            const cleanIp = String(ip).trim();
            if (net.isIP(cleanIp) === 0) {
                return reply.status(400).send({
                    error: 'Invalid IP address. Please enter a valid IPv4 or IPv6 address.'
                });
            }

            if (cleanIp === '172.0.0.1') {
                return reply.status(400).send({
                    error: '172.0.0.1 is not a valid Cyrus Docker network address. If you are using the default Cyrus Docker network, use 172.19.0.1 instead.'
                });
            }

            const node = await db.collection('nodes').findOne({ id: nodeId });
            if (!node) return reply.status(404).send({ error: 'Target node not found.' });

            const portList = new Set();
            const portTokens = String(ports).split(',').map(s => s.trim());

            for (const token of portTokens) {
                if (token.includes('-')) {
                    const [startStr, endStr] = token.split('-');
                    const start = parseInt(startStr, 10);
                    const end = parseInt(endStr, 10);
                    if (!isNaN(start) && !isNaN(end) && start <= end && start > 0 && end <= 65535) {
                        for (let p = start; p <= end; p++) portList.add(p);
                    }
                } else {
                    const p = parseInt(token, 10);
                    if (!isNaN(p) && p > 0 && p <= 65535) portList.add(p);
                }
            }

            if (portList.size === 0) {
                return reply.status(400).send({ error: 'No valid ports provided.' });
            }

            if (portList.size > 100) {
                return reply.status(400).send({ error: 'Limit exceeded: You can only create up to 100 allocations per request.' });
            }

            const existing = await db.collection('allocations').find({ nodeId, ip: cleanIp }).toArray();
            const existingPorts = new Set(existing.map(a => a.port));

            const toInsert = [];
            for (const port of portList) {
                if (!existingPorts.has(port)) {
                    toInsert.push({
                        id: generateAllocId(),
                        nodeId,
                        ip: cleanIp,
                        port,
                        assignedServerId: null,
                        createdAt: new Date().toISOString()
                    });
                }
            }

            if (toInsert.length === 0) {
                return reply.status(400).send({ error: 'All specified ports already exist for this IP.' });
            }

            await db.collection('allocations').insertMany(toInsert);

            return reply.status(201).send({
                success: true,
                message: `Successfully created ${toInsert.length} allocation(s).`
            });
        } catch (err) {
            console.error('[Admin Allocations POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ALLOCATIONS_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const { allocationId, allocationIds } = req.body || {};
            const targetIds = Array.isArray(allocationIds)
                ? allocationIds
                : (allocationId ? [allocationId] : []);

            if (targetIds.length === 0) {
                return reply.status(400).send({ error: 'At least one allocation ID is required.' });
            }

            const allocs = await db.collection('allocations').find({ id: { $in: targetIds } }).toArray();

            const assignedCount = allocs.filter(a => a.assignedServerId !== null).length;
            if (assignedCount > 0) {
                return reply.status(400).send({
                    error: `Action blocked: ${assignedCount} of the selected allocation(s) are assigned to active servers and cannot be removed.`
                });
            }

            const deleteResult = await db.collection('allocations').deleteMany({ id: { $in: targetIds } });

            return reply.status(200).send({
                success: true,
                message: `Successfully deleted ${deleteResult.deletedCount} allocation(s).`
            });
        } catch (err) {
            console.error('[Admin Allocations DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
