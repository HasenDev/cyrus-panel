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
            if (!permissions.includes('ADMIN_SERVERS') && !permissions.includes('ADMIN_USERS')) {
                return reply.status(403).send({ error: 'Forbidden: Missing permissions.' });
            }

            const query = String(req.query.q || '').trim();

            let filter = {};
            if (query.length > 0) {
                const safeRegex = new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
                filter = {
                    $or: [
                        { _id: query },
                        { username: safeRegex },
                        { email: safeRegex }
                    ]
                };
            }

            const users = await db.collection('users')
                .find(filter, { projection: { password: 0 } })
                .limit(15)
                .toArray();

            return reply.status(200).send({
                users: users.map(u => ({
                    id: u._id,
                    username: u.username,
                    email: u.email,
                    avatarUrl: u.avatarUrl || null
                }))
            });
        } catch (err) {
            console.error('[Admin Users Search GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};