const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');
const { version } = require('../../../../../package.json');

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_INFO_GET', 60, 60000)) return;

            const db = getDB();

            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) {
                return reply.status(404).send({ error: 'User record not found.' });
            }

            const userPermissions = getPermissions(user);
            if (!userPermissions.includes('ADMIN_OVERVIEW')) {
                return reply.status(403).send({ error: 'Forbidden: Insufficient permissions.' });
            }

            const usersCount = await db.collection('users').countDocuments({});
            const serversCount = await db.collection('servers').countDocuments({});

            return reply.status(200).send({
                apiVersion: version,
                usersCount: usersCount,
                serversCount: serversCount
            });
        } catch (err) {
            console.error('[Admin Info GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
