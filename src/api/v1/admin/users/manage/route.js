const { getDB } = require('../../../../../lib/db');
const { authenticate, hashPassword } = require('../../../../../lib/auth');
const { getPermissions } = require('../../../../../lib/getPermissions');
const { PERMISSIONS, getAccessLevel } = require('../../../../../lib/permissions');
const { checkRateLimit } = require('../../../../../lib/rateLimit');

const MAX_CREDITS_LIMIT = 999999999;

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_USER_MANAGE_GET', 60, 60000)) return;

            const db = getDB();
            const currentUser = await db.collection('users').findOne({ _id: req.userId });
            if (!currentUser) return reply.status(404).send({ error: 'User not found.' });

            const currentUserPermissions = (currentUser.admin || currentUser.developer)
                ? PERMISSIONS
                : getPermissions(currentUser);

            if (!currentUserPermissions.includes('ADMIN_USERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_USERS permission.' });
            }

            const { id } = req.query || {};
            if (!id) return reply.status(400).send({ error: 'User ID is required.' });

            const user = await db.collection('users').findOne({ _id: id }, { projection: { password: 0 } });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const accessLevel = getAccessLevel(user);

            const serverPage = Math.max(1, parseInt(req.query.serverPage || req.query.page, 10) || 1);
            const serverLimit = Math.max(1, parseInt(req.query.serverLimit || req.query.limit, 10) || 10);

            const userFilter = { $or: [{ ownerId: user._id }, { ownerId: id }] };
            const totalServers = await db.collection('servers').countDocuments(userFilter);
            const totalServerPages = Math.ceil(totalServers / serverLimit) || 1;
            const skip = (serverPage - 1) * serverLimit;

            const serverDocs = await db.collection('servers')
                .find(userFilter)
                .skip(skip)
                .limit(serverLimit)
                .toArray();

            const nodeIds = [...new Set(serverDocs.map(s => s.nodeId).filter(Boolean))];
            const nodes = await db.collection('nodes').find({ id: { $in: nodeIds } }).toArray();

            const primaryAllocIds = serverDocs.map(s => s.allocationId).filter(Boolean);
            const allocations = await db.collection('allocations').find({
                id: { $in: primaryAllocIds }
            }).toArray();

            const servers = serverDocs.map(s => {
                const nodeObj = nodes.find(n => n.id === s.nodeId);
                const primaryAlloc = allocations.find(a => a.id === s.allocationId);
                const allocStr = primaryAlloc ? `${primaryAlloc.ip}:${primaryAlloc.port}` : 'Unassigned';

                return {
                    id: s.id || s._id.toString(),
                    name: s.name,
                    description: s.description || '',
                    ownerUsername: s.ownerUsername || user.username,
                    nodeId: s.nodeId,
                    nodeName: nodeObj ? nodeObj.name : 'Unknown Node',
                    allocation: allocStr,
                    memory: s.memory || 0,
                    disk: s.disk || 0,
                    cpu: s.cpu || 0,
                    priceCredits: s.priceCredits || 0,
                    createdAt: s.createdAt
                };
            });

            return reply.status(200).send({
                user: {
                    id: user._id,
                    email: user.email,
                    username: user.username,
                    admin: !!user.admin,
                    developer: !!user.developer || user.role === 'developer',
                    bot: !!user.bot,
                    accessLevel: accessLevel,
                    credits: user.credits || 0,
                    maxRam: user.maxRam || 0,
                    maxDeployments: user.maxDeployments || 0,
                    avatarUrl: user.avatarUrl || null,
                    permissions: Array.isArray(user.permissions) ? user.permissions : [],
                    totalServers,
                    createdAt: user.createdAt || Date.now()
                },
                currentUserPermissions,
                availablePermissions: PERMISSIONS,
                servers,
                serverPagination: {
                    page: serverPage,
                    limit: serverLimit,
                    totalPages: totalServerPages,
                    total: totalServers
                }
            });
        } catch (err) {
            console.error('[Admin User Manage GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_USER_MANAGE_PUT', 30, 60000)) return;
            const db = getDB();
            const currentUser = await db.collection('users').findOne({ _id: req.userId });
            if (!currentUser) return reply.status(404).send({ error: 'User not found.' });
            const isReqUserFullAdmin = currentUser.admin === true || currentUser.developer === true;
            const currentUserPermissions = isReqUserFullAdmin
                ? PERMISSIONS
                : getPermissions(currentUser);

            if (!currentUserPermissions.includes('ADMIN_USERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_USERS permission.' });
            }

            const { id, email, username, password, credits, permissions } = req.body || {};
            if (!id) return reply.status(400).send({ error: 'User ID is required.' });

            const targetUser = await db.collection('users').findOne({ _id: id });
            if (!targetUser) return reply.status(404).send({ error: 'Target user not found.' });

            const updates = {};

            if (email) {
                const cleanEmail = email.trim().toLowerCase();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(cleanEmail)) {
                    return reply.status(400).send({ error: 'Invalid email address.' });
                }
                const existing = await db.collection('users').findOne({ email: cleanEmail, _id: { $ne: id } });
                if (existing) return reply.status(409).send({ error: 'Email is already taken.' });
                updates.email = cleanEmail;
            }

            if (username) {
                const cleanUsername = username.trim();
                const usernameRegex = /^[a-zA-Z0-9 ]{2,16}$/;
                if (!usernameRegex.test(cleanUsername)) {
                    return reply.status(400).send({ error: 'Username must be 2-16 alphanumeric characters.' });
                }
                const existing = await db.collection('users').findOne({
                    username: { $regex: new RegExp(`^${cleanUsername.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') },
                    _id: { $ne: id }
                });
                if (existing) return reply.status(409).send({ error: 'Username is already taken.' });
                updates.username = cleanUsername;
            }

            if (password && password.trim().length >= 6) {
                updates.password = await hashPassword(password.trim());
            }

            if (credits !== undefined && credits !== null) {
                const parsedCredits = Number(credits);
                if (isNaN(parsedCredits) || parsedCredits < 0) {
                    return reply.status(400).send({ error: 'Credits must be a valid non-negative number.' });
                }
                if (parsedCredits > MAX_CREDITS_LIMIT) {
                    return reply.status(400).send({ error: `Credits cannot exceed ${MAX_CREDITS_LIMIT.toLocaleString()} credits.` });
                }

                const newCredits = Math.floor(parsedCredits);
                const oldCredits = targetUser.credits || 0;
                const creditDiff = newCredits - oldCredits;

                if (creditDiff !== 0) {
                    updates.credits = newCredits;

                    await db.collection('transactions').insertOne({
                        id: `ADM-${Math.floor(10000 + Math.random() * 90000)}`,
                        userId: id,
                        credits: creditDiff,
                        amountUSD: 0,
                        type: creditDiff > 0 ? 'admin_add' : 'admin_remove',
                        status: 'Completed',
                        description: creditDiff > 0
                            ? `Admin added ${Math.abs(creditDiff).toLocaleString()} Credits`
                            : `Admin removed ${Math.abs(creditDiff).toLocaleString()} Credits`,
                        createdAt: new Date().toISOString()
                    });
                }
            }

            if (Array.isArray(permissions)) {
                if (targetUser.admin === true || targetUser.developer === true) {
                    return reply.status(403).send({ error: 'Full Administrators/Developers permissions cannot be altered.' });
                }

                const targetCurrentPerms = Array.isArray(targetUser.permissions) ? targetUser.permissions : [];
                const added = permissions.filter(p => !targetCurrentPerms.includes(p));
                const removed = targetCurrentPerms.filter(p => !permissions.includes(p));
                const changed = [...added, ...removed];

                if (!isReqUserFullAdmin) {
                    const unauthorized = changed.filter(p => !currentUserPermissions.includes(p));
                    if (unauthorized.length > 0) {
                        return reply.status(403).send({
                            error: `Missing permission assignment rights: ${unauthorized.join(', ')}`
                        });
                    }
                }

                updates.permissions = permissions.filter(p => PERMISSIONS.includes(p));
            }

            if (Object.keys(updates).length === 0) {
                return reply.status(400).send({ error: 'No valid update fields provided.' });
            }

            await db.collection('users').updateOne({ _id: id }, { $set: updates });

            return reply.status(200).send({ success: true, message: 'User updated successfully.' });
        } catch (err) {
            console.error('[Admin User Manage PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_USER_MANAGE_DELETE', 10, 60000)) return;
            const db = getDB();
            const currentUser = await db.collection('users').findOne({ _id: req.userId });
            if (!currentUser) return reply.status(404).send({ error: 'User not found.' });
            const permissions = getPermissions(currentUser);
            if (!permissions.includes('ADMIN_USERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_USERS permission.' });
            }
            const { id } = req.body || {};
            if (!id) return reply.status(400).send({ error: 'User ID is required.' });

            if (id === req.userId) {
                return reply.status(400).send({ error: 'You cannot delete your own account.' });
            }
            const targetUser = await db.collection('users').findOne({ _id: id });
            if (!targetUser) return reply.status(404).send({ error: 'User not found.' });

            if (targetUser.admin === true || targetUser.developer === true) {
                return reply.status(403).send({ error: 'Full Administrators cannot be deleted.' });
            }

            const activeServersCount = await db.collection('servers').countDocuments({
                $or: [{ ownerId: targetUser._id }, { ownerId: id }]
            });

            if (activeServersCount > 0) {
                return reply.status(400).send({
                    error: 'Cannot delete user because they still have active servers. Please delete their servers first.'
                });
            }

            await db.collection('users').deleteOne({ _id: id });
            return reply.status(200).send({ success: true, message: 'User deleted successfully.' });
        } catch (err) {
            console.error('[Admin User Manage DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};