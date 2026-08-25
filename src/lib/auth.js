const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getDB } = require('./db');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

function getSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
        throw new Error('JWT_SECRET environment variable is missing or empty.');
    }
    return secret;
}

function timingSafeEqualStr(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function generateToken(userId) {
    if (!userId || typeof userId !== 'string') {
        throw new Error('Valid userId is required to generate token.');
    }

    const secret = getSecret();
    const b64Id = Buffer.from(userId, 'utf8').toString('base64url');
    const b64Time = Buffer.from(Date.now().toString(), 'utf8').toString('base64url');
    
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${b64Id}.${b64Time}`)
        .digest('base64url');

    return `${b64Id}.${b64Time}.${signature}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    try {
        let cleanToken = token.trim();
        if (cleanToken.startsWith('Bearer ')) {
            cleanToken = cleanToken.slice(7).trim();
        }

        const parts = cleanToken.split('.');
        if (parts.length !== 3) {
            return null;
        }

        const [b64Id, b64Time, signature] = parts;
        if (!b64Id || !b64Time || !signature) {
            return null;
        }

        const secret = getSecret();
        const expectedSig = crypto
            .createHmac('sha256', secret)
            .update(`${b64Id}.${b64Time}`)
            .digest('base64url');

        if (!timingSafeEqualStr(signature, expectedSig)) {
            return null;
        }

        const rawTimestamp = Buffer.from(b64Time, 'base64url').toString('utf8');
        const tokenTime = parseInt(rawTimestamp, 10);

        if (!Number.isSafeInteger(tokenTime) || tokenTime <= 0) {
            return null;
        }

        const now = Date.now();
        if (now - tokenTime > THIRTY_DAYS_MS) {
            return null;
        }
        if (tokenTime > now + CLOCK_SKEW_TOLERANCE_MS) {
            return null;
        }

        const userId = Buffer.from(b64Id, 'base64url').toString('utf8');
        return userId.length > 0 ? userId : null;
    } catch {
        return null;
    }
}

async function hashPassword(password) {
    return await bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
}

const createAuthenticator = (bypassBanCheck = false) => {
    return async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader) return reply.status(401).send({ error: 'Unauthorized' });
        
        const userId = verifyToken(authHeader);
        if (!userId) return reply.status(401).send({ error: 'Invalid or expired token' });
        
        request.userId = userId;
        const db = getDB();

        const user = await db.collection('users').findOne(
            { _id: userId },
            { projection: { banned: 1, bot: 1 } }
        );

        if (!user) {
            return reply.status(401).send({ error: 'User not found' });
        }

        if (user.bot) {
            let cleanToken = authHeader.trim();
            if (cleanToken.startsWith('Bearer ')) {
                cleanToken = cleanToken.slice(7).trim();
            }
            const botTokenDoc = await db.collection('bot_tokens').findOne({ botId: userId });
            if (!botTokenDoc || !timingSafeEqualStr(botTokenDoc.token, cleanToken)) {
                return reply.status(401).send({ error: 'Invalid Bot Token' });
            }
        }

        if (!bypassBanCheck && user.banned) {
            const now = Date.now();
            const isPerma = user.banned.perma;
            const expiresAt = user.banned.expiresAt;
            
            if (isPerma || (expiresAt && expiresAt > now)) {
                return reply.status(403).send({ 
                    error: 'Banned', 
                    banned: user.banned 
                });
            }
        }
    };
};

const authenticate = createAuthenticator(false);
const authenticateBypass = createAuthenticator(true);

module.exports = { 
    generateToken, 
    verifyToken, 
    hashPassword, 
    verifyPassword, 
    authenticate, 
    authenticateBypass 
};
