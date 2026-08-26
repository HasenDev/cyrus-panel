const crypto = require('crypto');
const { getDB } = require('../../../../lib/db');
const { hashPassword, generateToken } = require('../../../../lib/auth');
const { sendVerificationEmail, getEnv } = require('../../../../lib/emailHandler');

const getRecaptchaConfig = () => {
    const env = getEnv();
    const secret = env.RECAPTCHA_SECRET_KEY || env.RECAPTCHA_SECRET || process.env.RECAPTCHA_SECRET_KEY || process.env.RECAPTCHA_SECRET;
    const siteKey = env.RECAPTCHA_PUBLIC_KEY || env.RECAPTCHA_SITE_KEY || process.env.RECAPTCHA_PUBLIC_KEY || process.env.RECAPTCHA_SITE_KEY;
    const enabled = (env.RECAPTCHA_ENABLED === 'true' || process.env.RECAPTCHA_ENABLED === 'true') && !!secret;
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
        console.error('[Recaptcha Error]:', err);
        return false;
    }
}

module.exports = {
    rateLimit: {
        max: 5,
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
            const { email, username, password, captchaToken, inviteCode, acceptTosAndPrivacy } = req.body || {};
            const db = getDB();
            const config = getRecaptchaConfig();

            if (acceptTosAndPrivacy !== true) {
                return reply.status(400).send({ error: 'You must accept the Terms of Service and Privacy Policy.' });
            }

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
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (cleanEmail.length > 254 || !emailRegex.test(cleanEmail)) {
                return reply.status(400).send({ error: 'Please enter a valid email address.' });
            }
            const [localPart, domainPart] = cleanEmail.split('@');
            const isGmail = domainPart === 'gmail.com' || domainPart === 'googlemail.com';

            if (isGmail && localPart.includes('.')) {
                return reply.status(400).send({
                    error: "Nice try. The Gmail dot trick has been patched. Please enter your email address without extra dots."
                });
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
            if (password.length > 72) {
                return reply.status(400).send({ error: 'Password is too long. Maximum length is 72 characters.' });
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

            const env = getEnv();
            const emailEnabled = env.EMAIL_ENABLED === 'true' || process.env.EMAIL_ENABLED === 'true';
            const resendApiKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
            const emailVerificationRequired = emailEnabled && !!resendApiKey;

            const passwordHash = await hashPassword(password);
            const userId = crypto.randomUUID();
            const timestamp = Date.now();

            const newUserDoc = {
                _id: userId,
                email: cleanEmail,
                username: cleanUsername,
                password: passwordHash,
                banned: null,
                bot: false,
                emailVerified: !emailVerificationRequired,
                inviteCodeUsed: inviteCode ? inviteCode.trim() : null,
                acceptTosAndPrivacy: true,
                acceptedTosAndPrivacyAt: timestamp,
                createdAt: timestamp
            };

            await db.collection('users').insertOne(newUserDoc);
            if (emailVerificationRequired) {
                const verifyCode = crypto.randomBytes(32).toString('hex');
                await db.collection('email_verifications').insertOne({
                    userId: userId,
                    code: verifyCode,
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
                });

                const baseUrl = env.API_URL || env.APP_URL || env.PANEL_URL || process.env.API_URL || process.env.APP_URL || process.env.PANEL_URL || (req.headers.origin ? req.headers.origin : (req.headers.host ? `${req.protocol || 'http'}://${req.headers.host}` : null));
                if (!baseUrl) {
                    return reply.status(500).send({ error: 'Server is not properly configured. Please contact an administrator.' });
                }
                const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify-email?code=${verifyCode}`;

                await sendVerificationEmail({
                    to: cleanEmail,
                    username: cleanUsername,
                    verifyUrl
                });
            }

            const token = generateToken(userId);

            return reply.status(201).send({
                success: true,
                token,
                emailVerificationRequired,
                user: {
                    id: userId,
                    email: cleanEmail,
                    username: cleanUsername,
                    emailVerified: !emailVerificationRequired
                }
            });

        } catch (err) {
            console.error('[Registration Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
