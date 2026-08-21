const { getDB } = require('./db');
const { hashPassword } = require('./auth');

async function changeUserPassword(userId, newPassword) {
    const db = getDB();
    const hashedPassword = await hashPassword(newPassword);
    const now = new Date();
    await db.collection('users').updateOne(
        { _id: userId },
        {
            $set: {
                password: hashedPassword,
                passwordChangedAt: now
            }
        }
    );
    try {
        const nodes = await db.collection('nodes').find({}).toArray();
        await Promise.all(nodes.map(async (node) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);
                await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/user/revoke-ws`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${node.daemonKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ userId }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
            } catch {
            }
        }));
    } catch (err) {
        console.error('[changeUserPassword] Revocation broadcast error:', err);
    }

    return true;
}

module.exports = { changeUserPassword };