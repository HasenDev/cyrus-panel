const crypto = require('crypto');
const { getDB } = require('../../../../lib/db');
const { sendPasswordResetEmail, getEnv } = require('../../../../lib/emailHandler');
const { getClientIp } = require('../../../../lib/getIP');

const getRecaptchaConfig = () => {
    const env = getEnv();
    const secret = env.RECAPTCHA_SECRET_KEY || env.RECAPTCHA_SECRET;
    const siteKey = env.RECAPTCHA_PUBLIC_KEY || env.RECAPTCHA_SITE_KEY;
    const enabled = env.RECAPTCHA_ENABLED === 'true' && !!secret;
    return { enabled, secret, siteKey };
};

async function verifyCaptcha(token, secret) {
    if (!secret || !token) return false;
    try {
        const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret, response: token }).toString()
        });
        const data = await response.json();
        return !!data.success;
    } catch (err) {
        console.error('[Forgot Password Recaptcha Error]:', err);
        return false;
    }
}

module.exports = {
    rateLimit: {
        max: 10,
        timeWindow: '1 minute'
    },
    GET: async (req, reply) => {
        try {
            const { enabled, siteKey } = getRecaptchaConfig();
            return reply.status(200).send({
                recaptchaRequired: enabled,
                siteKey: enabled ? siteKey : null
            });
        } catch (err) {
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            const { email, captchaToken } = req.body || {};
            const clientIp = getClientIp(req);
            const config = getRecaptchaConfig();

            if (config.enabled) {
                const captchaPassed = await verifyCaptcha(captchaToken, config.secret);
                if (!captchaPassed) {
                    return reply.status(400).send({ error: 'Security verification failed. Please try again.' });
                }
            }

            if (!email || typeof email !== 'string') {
                return reply.status(400).send({ error: 'Email address is required.' });
            }

            const cleanEmail = email.trim().toLowerCase();
            const db = getDB();
            const user = await db.collection('users').findOne({ email: cleanEmail });
            if (!user) {
                return reply.status(200).send({
                    success: true,
                    message: 'If that email address is registered, a password reset link has been sent.'
                });
            }

            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const userRequestsCount = await db.collection('password_reset_requests').countDocuments({
                userId: user._id,
                createdAt: { $gte: oneHourAgo }
            });

            if (userRequestsCount >= 3) {
                return reply.status(200).send({
                    success: true,
                    message: 'If that email address is registered, a password reset link has been sent.'
                });
            }
            const ipRequestsCount = await db.collection('password_reset_requests').countDocuments({
                ip: clientIp,
                createdAt: { $gte: oneHourAgo }
            });

            if (ipRequestsCount >= 2) {
                return reply.status(200).send({
                    success: true,
                    message: 'If that email address is registered, a password reset link has been sent.'
                });
            }
            await db.collection('password_reset_requests').insertOne({
                userId: user._id,
                ip: clientIp,
                createdAt: new Date()
            });

            const resetCode = crypto.randomBytes(32).toString('hex');

            await db.collection('password_resets').deleteMany({ userId: user._id });
            await db.collection('password_resets').insertOne({
                userId: user._id,
                code: resetCode,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

            const env = getEnv();
            const baseUrl = env.APP_URL || env.PANEL_URL;
            if (!baseUrl) {
                return reply.status(500).send({ error: 'Server is not properly configured. Please contact an administrator.' });
            }
            const resetUrl = `${baseUrl.replace(/\/$/, '')}/reset-password?code=${resetCode}`;

            await sendPasswordResetEmail({
                to: user.email,
                username: user.username,
                resetUrl
            });

            return reply.status(200).send({
                success: true,
                message: 'If that email address is registered, a password reset link has been sent.'
            });
        } catch (err) {
            console.error('[Forgot Password Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
