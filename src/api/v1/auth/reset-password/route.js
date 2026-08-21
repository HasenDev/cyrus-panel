const { getDB } = require('../../../../lib/db');
const auth = require('../../../../lib/auth');
const { changeUserPassword } = require('../../../../lib/changePasswordHandler');

async function checkIsSamePassword(plainPassword, currentHash) {
    if (!plainPassword || !currentHash) return false;
    if (typeof auth.verifyPassword === 'function') {
        try { return await auth.verifyPassword(plainPassword, currentHash); } catch (e) {}
    }
    return false;
}

module.exports = {
    rateLimit: { max: 10, timeWindow: '1 minute' },
    GET: async (req, reply) => {
        try {
            const code = req.query?.code;
            if (!code || typeof code !== 'string') {
                return reply.status(400).send({ valid: false, error: 'Reset code is required.' });
            }

            const db = getDB();
            const resetDoc = await db.collection('password_resets').findOne({ code: code.trim() });

            if (!resetDoc || new Date() > new Date(resetDoc.expiresAt)) {
                if (resetDoc) await db.collection('password_resets').deleteOne({ _id: resetDoc._id });
                return reply.status(400).send({ valid: false, error: 'Invalid or expired password reset link.' });
            }

            return reply.status(200).send({ valid: true });
        } catch (err) {
            console.error('[Reset Password GET Error]:', err);
            return reply.status(500).send({ valid: false, error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            const { code, newPassword } = req.body || {};

            if (!code || typeof code !== 'string') {
                return reply.status(400).send({ error: 'Reset code is required.' });
            }
            if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 72) {
                return reply.status(400).send({ error: 'New password must be between 6 and 72 characters.' });
            }

            const db = getDB();
            const resetDoc = await db.collection('password_resets').findOne({ code: code.trim() });

            if (!resetDoc || new Date() > new Date(resetDoc.expiresAt)) {
                if (resetDoc) await db.collection('password_resets').deleteOne({ _id: resetDoc._id });
                return reply.status(400).send({ error: 'Invalid or expired password reset link.' });
            }

            const user = await db.collection('users').findOne({ _id: resetDoc.userId });
            if (!user) return reply.status(404).send({ error: 'User account not found.' });

            if (await checkIsSamePassword(newPassword, user.password)) {
                return reply.status(400).send({ error: 'Your new password cannot be the same as your current password.' });
            }

            await changeUserPassword(resetDoc.userId, newPassword);
            await db.collection('password_resets').deleteMany({ userId: resetDoc.userId });

            return reply.status(200).send({
                success: true,
                message: 'Password reset successfully. You can now log in with your new password.'
            });
        } catch (err) {
            console.error('[Reset Password POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};