const { getDB } = require('../../../../lib/db');
const { authenticate, hashPassword, verifyPassword } = require('../../../../lib/auth');
const UploadHelper = require('../../../../lib/UploadHelper');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ACCOUNT_SETTINGS_POST', 15, 60000)) return;
            const db = getDB();
            const { username, email, currentPassword, newPassword, avatar } = req.body || {};
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found' });
            const updateDoc = {};
            if (username && username !== user.username) {
                const cleanUsername = username.trim();
                const usernameRegex = /^[a-zA-Z0-9 ]{2,16}$/;
                if (!usernameRegex.test(cleanUsername)) {
                    return reply.status(400).send({ error: 'Username must be 2-16 alphanumeric characters.' });
                }
                const existing = await db.collection('users').findOne({ 
                    username: { $regex: new RegExp(`^${cleanUsername.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') },
                    _id: { $ne: user._id }
                });
                if (existing) return reply.status(409).send({ error: 'Username is already taken.' });
                updateDoc.username = cleanUsername;
            }
            if (email || newPassword) {
                if (!currentPassword) {
                    return reply.status(400).send({ error: 'Current password is required to update email or password.' });
                }
                const isMatch = await verifyPassword(currentPassword, user.password);
                if (!isMatch) return reply.status(401).send({ error: 'Current password provided is incorrect.' });

                if (email && email.toLowerCase() !== user.email) {
                    const cleanEmail = email.trim().toLowerCase();
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(cleanEmail)) return reply.status(400).send({ error: 'Invalid email format.' });
                    const [localPart, domainPart] = cleanEmail.split('@');
                    const isGmail = domainPart === 'gmail.com' || domainPart === 'googlemail.com';

                    if (isGmail && localPart.includes('.')) {
                        return reply.status(400).send({
                            error: "Nice try. The Gmail dot trick has been patched. Please enter your email address without extra dots."
                        });
                    }

                    const existingEmail = await db.collection('users').findOne({ email: cleanEmail });
                    if (existingEmail) return reply.status(409).send({ error: 'Email already in use.' });
                    updateDoc.email = cleanEmail;
                }

                if (newPassword) {
                    if (newPassword.length < 6 || newPassword.length > 72) {
                        return reply.status(400).send({ error: 'New password must be 6-72 characters.' });
                    }
                    if (await verifyPassword(newPassword, user.password)) {
                        return reply.status(400).send({ error: 'New password cannot be the same as your old password.' });
                    }
                    updateDoc.password = await hashPassword(newPassword);
                }
            }
            if (avatar) {
                try {
                    const avatarUrl = await UploadHelper.uploadBase64Stream(
                        avatar, 
                        'avatars', 
                        user._id, 
                        user.avatarUrl
                    );
                    if (avatarUrl) updateDoc.avatarUrl = avatarUrl;
                } catch (uploadErr) {
                    return reply.status(400).send({ error: uploadErr.message });
                }
            }

            if (Object.keys(updateDoc).length === 0) {
                return reply.status(400).send({ error: 'No changes provided.' });
            }

            await db.collection('users').updateOne(
                { _id: req.userId },
                { $set: updateDoc }
            );

            return reply.status(200).send({ success: true, message: 'Settings updated successfully.' });

        } catch (err) {
            console.error('[Settings Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};