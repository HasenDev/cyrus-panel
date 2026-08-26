const jwt = require('jsonwebtoken');
const { getDB } = require('../../../../lib/db');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    POST: async (req, reply) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return reply.status(401).send({ valid: false, error: 'Daemon authorization token required.' });
            }

            let daemonKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

            const db = getDB();
            const node = await db.collection('nodes').findOne({ daemonKey });
            if (!node) {
                return reply.status(401).send({ valid: false, error: 'Invalid daemon key.' });
            }

            if (checkRateLimit(reply, node.id, 'DAEMON_VERIFY_TOKEN', 120, 60000)) return;

            const { token, serverId } = req.body || {};
            if (!token || !serverId) {
                return reply.status(400).send({ valid: false, error: 'Token and serverId are required.' });
            }

            let decoded;
            try {
                decoded = jwt.verify(token, node.daemonKey);
            } catch (jwtErr) {
                return reply.status(200).send({ valid: false, reason: 'TOKEN_EXPIRED' });
            }

            if (decoded.serverId !== serverId || decoded.nodeId !== node.id) {
                return reply.status(200).send({ valid: false, reason: 'INVALID_TARGET' });
            }

            const user = await db.collection('users').findOne({ _id: decoded.userId });
            if (!user) {
                return reply.status(200).send({ valid: false, reason: 'USER_NOT_FOUND' });
            }

            const currentPasswordChangedAt = user.passwordChangedAt ? new Date(user.passwordChangedAt).getTime() : 0;
            const tokenPasswordChangedAt = decoded.passwordChangedAt || 0;

            if (currentPasswordChangedAt > tokenPasswordChangedAt) {
                return reply.status(200).send({ valid: false, reason: 'PASSWORD_CHANGED' });
            }

            return reply.status(200).send({
                valid: true,
                serverId: decoded.serverId,
                userId: decoded.userId,
                canConsole: decoded.canConsole === true,
                canPower: decoded.canPower === true
            });
        } catch (err) {
            console.error('[Verify WS Token Error]:', err);
            return reply.status(500).send({ valid: false, error: 'Internal server error' });
        }
    }
};
