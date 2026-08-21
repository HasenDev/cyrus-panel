const crypto = require('crypto');
const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { sendVerificationEmail, getEnv } = require('../../../../lib/emailHandler');
const { getClientIp } = require('../../../../lib/getIP');

module.exports = {
    rateLimit: { max: 30, timeWindow: '1 minute' },
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
                success: true,
                emailVerified: !!user.emailVerified
            });
        } catch (err) {
            console.error('[Resend Verification GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            const clientIp = getClientIp(req);
            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) {
                return reply.status(200).send({
                    success: true,
                    message: 'Verification link sent to your email address.'
                });
            }

            if (user.emailVerified) {
                return reply.status(400).send({ error: 'Email address is already verified.' });
            }

            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const userRequestsCount = await db.collection('email_verification_requests').countDocuments({
                userId: user._id,
                createdAt: { $gte: oneHourAgo }
            });

            if (userRequestsCount >= 3) {
                return reply.status(200).send({
                    success: true,
                    message: 'Verification link sent to your email address.'
                });
            }
            const ipRequestsCount = await db.collection('email_verification_requests').countDocuments({
                ip: clientIp,
                createdAt: { $gte: oneHourAgo }
            });

            if (ipRequestsCount >= 2) {
                return reply.status(200).send({
                    success: true,
                    message: 'Verification link sent to your email address.'
                });
            }
            await db.collection('email_verification_requests').insertOne({
                userId: user._id,
                ip: clientIp,
                createdAt: new Date()
            });

            const verifyCode = crypto.randomBytes(32).toString('hex');

            await db.collection('email_verifications').deleteMany({ userId: user._id });
            await db.collection('email_verifications').insertOne({
                userId: user._id,
                code: verifyCode,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            const env = getEnv();
            const hostOrigin = req.headers.origin || req.headers.host;
            const baseUrl = env.APP_URL || env.PANEL_URL || (hostOrigin && hostOrigin.startsWith('http') ? hostOrigin : `https://${hostOrigin}`);
            const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify-email?code=${verifyCode}`;

            await sendVerificationEmail({
                to: user.email,
                username: user.username,
                verifyUrl
            });

            return reply.status(200).send({
                success: true,
                message: 'Verification link sent to your email address.'
            });
        } catch (err) {
            console.error('[Resend Verification POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};