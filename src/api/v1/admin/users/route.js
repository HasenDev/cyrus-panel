const crypto = require('crypto');
const { getDB } = require('../../../../lib/db');
const { authenticate, hashPassword } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { getAccessLevel } = require('../../../../lib/permissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_USERS_GET', 40, 60000)) return;

            const db = getDB();
            const currentUser = await db.collection('users').findOne({ _id: req.userId });
            if (!currentUser) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(currentUser);
            if (!permissions.includes('ADMIN_USERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_USERS permission.' });
            }

            const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
            const limit = Math.max(1, Math.min(100, parseInt(req.query?.limit, 10) || 10));
            const search = String(req.query?.search || '').trim();

            let filter = {};
            if (search) {
                filter = {
                    $or: [
                        { username: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } },
                        { _id: search }
                    ]
                };
            }

            const totalUsers = await db.collection('users').countDocuments(filter);
            const totalPages = Math.max(1, Math.ceil(totalUsers / limit));
            const actualPage = page > totalPages ? totalPages : page;
            const skip = (actualPage - 1) * limit;

            const users = await db.collection('users')
                .find(filter, { projection: { password: 0 } })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            const formattedUsers = users.map(u => ({
                id: u._id,
                email: u.email,
                username: u.username,
                admin: !!u.admin,
                developer: !!u.developer || u.role === 'developer',
                accessLevel: getAccessLevel(u),
                bot: !!u.bot,
                credits: u.credits || 0,
                avatarUrl: u.avatarUrl || null,
                createdAt: u.createdAt || Date.now()
            }));

            return reply.status(200).send({
                users: formattedUsers,
                pagination: {
                    total: totalUsers,
                    totalPages: totalPages,
                    currentPage: actualPage,
                    limit: limit
                }
            });
        } catch (err) {
            console.error('[Admin Users GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },

    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_USERS_CREATE', 10, 60000)) return;

            const db = getDB();
            const currentUser = await db.collection('users').findOne({ _id: req.userId });
            if (!currentUser) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(currentUser);
            if (!permissions.includes('ADMIN_USERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_USERS permission.' });
            }

            const { email, username, password } = req.body || {};

            if (!email || typeof email !== 'string') {
                return reply.status(400).send({ error: 'Email address is required.' });
            }
            const cleanEmail = email.trim().toLowerCase();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (cleanEmail.length > 254 || !emailRegex.test(cleanEmail)) {
                return reply.status(400).send({ error: 'Please enter a valid email address.' });
            }

            if (!username || typeof username !== 'string') {
                return reply.status(400).send({ error: 'Username is required.' });
            }
            const cleanUsername = username.trim();
            const usernameRegex = /^[a-zA-Z0-9 ]{2,16}$/;
            if (!usernameRegex.test(cleanUsername)) {
                return reply.status(400).send({ error: 'Username must be 2-16 alphanumeric characters or spaces.' });
            }

            if (!password || typeof password !== 'string' || password.length < 6) {
                return reply.status(400).send({ error: 'Password must be at least 6 characters long.' });
            }

            const existingEmail = await db.collection('users').findOne({ email: cleanEmail });
            if (existingEmail) {
                return reply.status(409).send({ error: 'Email address is already registered.' });
            }

            const existingUsername = await db.collection('users').findOne({
                username: { $regex: new RegExp(`^${cleanUsername.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') }
            });
            if (existingUsername) {
                return reply.status(409).send({ error: 'Username is already taken.' });
            }

            const passwordHash = await hashPassword(password);
            const userId = crypto.randomUUID();

            const newUserDoc = {
                _id: userId,
                email: cleanEmail,
                username: cleanUsername,
                password: passwordHash,
                admin: false,
                bot: false,
                credits: 0,
                createdAt: Date.now()
            };

            await db.collection('users').insertOne(newUserDoc);

            return reply.status(201).send({
                success: true,
                message: 'User created successfully.',
                user: {
                    id: userId,
                    email: cleanEmail,
                    username: cleanUsername
                }
            });
        } catch (err) {
            console.error('[Admin Users POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};