const { getDB } = require('../../../../lib/db');
const { verifyPassword, generateToken } = require('../../../../lib/auth');

module.exports = {
    rateLimit: {
        max: 5,
        timeWindow: '1 minute'
    },
    POST: async (req, reply) => {
        try {
            const { email, password } = req.body || {};
            const db = getDB();

            if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
                return reply.status(400).send({ error: 'Missing email address or password parameters.' });
            }
            const cleanEmail = email.trim().toLowerCase();
            const user = await db.collection('users').findOne({ email: cleanEmail });
            if (!user) {
                return reply.status(401).send({ error: 'Incorrect email address or password.' });
            }
            const isMatch = await verifyPassword(password, user.password);
            if (!isMatch) {
                return reply.status(401).send({ error: 'Incorrect email address or password.' });
            }
            if (user.banned) {
                const now = Date.now();
                const isPerma = user.banned.perma;
                const expiresAt = user.banned.expiresAt;
                
                if (isPerma || (expiresAt && expiresAt > now)) {
                    return reply.status(403).send({ 
                        error: 'Your account has been banned.', 
                        banned: user.banned 
                    });
                }
            }
            const token = generateToken(user._id);

            return reply.status(200).send({
                success: true,
                token,
                user: {
                    id: user._id,
                    email: user.email,
                    username: user.username,
                    createdAt: user.createdAt
                }
            });

        } catch (err) {
            console.error('[Login Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};