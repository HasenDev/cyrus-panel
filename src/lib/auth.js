const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getDB } = require('./db');

const SECRET = process.env.JWT_SECRET;

function generateToken(userId) {
    const b64Id = Buffer.from(userId).toString('base64url');
    const b64Time = Buffer.from(Date.now().toString()).toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET).update(`${b64Id}.${b64Time}`).digest('base64url');
    return `${b64Id}.${b64Time}.${signature}`;
}

function verifyToken(token) {
    try {
        let cleanToken = token;
        if (cleanToken.startsWith('Bearer ')) {
            cleanToken = cleanToken.slice(7);
        }
        const [b64Id, b64Time, signature] = cleanToken.split('.');
        const expectedSig = crypto.createHmac('sha256', SECRET).update(`${b64Id}.${b64Time}`).digest('base64url');
        if (signature !== expectedSig) return null;
        return Buffer.from(b64Id, 'base64url').toString('utf-8');
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
        if (!userId) return reply.status(401).send({ error: 'Invalid Token' });
        
        request.userId = userId;
        const db = getDB();

        const user = await db.collection('users').findOne(
            { _id: userId },
            { projection: { banned: 1, bot: 1 } }
        );

        if (user && user.bot) {
            let cleanToken = authHeader;
            if (cleanToken.startsWith('Bearer ')) {
                cleanToken = cleanToken.slice(7);
            }
            const botTokenDoc = await db.collection('bot_tokens').findOne({ botId: userId });
            if (!botTokenDoc || botTokenDoc.token !== cleanToken) {
                return reply.status(401).send({ error: 'Invalid Bot Token' });
            }
        }

        if (!bypassBanCheck) {
            if (user && user.banned) {
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
        }
    };
};

const authenticate = createAuthenticator(false);
const authenticateBypass = createAuthenticator(true);

module.exports = { generateToken, verifyToken, hashPassword, verifyPassword, authenticate, authenticateBypass };