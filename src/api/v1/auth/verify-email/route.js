const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');

module.exports = {
    rateLimit: { max: 10, timeWindow: '1 minute' },
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });

            if (!user) {
                return reply.status(404).send({ error: 'User not found.' });
            }

            return reply.status(200).send({
                emailVerified: !!user.emailVerified
            });
        } catch (err) {
            console.error('[Verify Email GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            const { code } = req.body || {};

            if (!code || typeof code !== 'string') {
                return reply.status(400).send({ error: 'Verification code is required.' });
            }

            const db = getDB();
            const verification = await db.collection('email_verifications').findOne({ code: code.trim() });

            if (!verification) {
                return reply.status(400).send({ error: 'Invalid or expired verification link.' });
            }

            if (new Date() > new Date(verification.expiresAt)) {
                await db.collection('email_verifications').deleteOne({ _id: verification._id });
                return reply.status(400).send({ error: 'Verification link has expired.' });
            }

            await db.collection('users').updateOne(
                { _id: verification.userId },
                { $set: { emailVerified: true } }
            );

            await db.collection('email_verifications').deleteMany({ userId: verification.userId });

            return reply.status(200).send({
                success: true,
                message: 'Email address verified successfully.'
            });
        } catch (err) {
            console.error('[Verify Email POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};