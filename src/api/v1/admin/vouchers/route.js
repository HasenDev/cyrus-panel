const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function generateVoucherId() {
    return 'vouch_' + Math.random().toString(36).substring(2, 9);
}

function generateVoucherCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let p1 = '', p2 = '';
    for (let i = 0; i < 4; i++) {
        p1 += chars.charAt(Math.floor(Math.random() * chars.length));
        p2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${p1}-${p2}`;
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_VOUCHERS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_VOUCHERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_VOUCHERS permission.' });
            }

            const vouchers = await db.collection('vouchers').find({}).sort({ createdAt: -1 }).toArray();

            const formatted = vouchers.map(v => ({
                id: v.id || v._id.toString(),
                code: v.code,
                credits: v.credits || 0,
                maxUses: v.maxUses || 0,
                usesCount: v.usesCount || 0,
                expiresAt: v.expiresAt || null,
                createdAt: v.createdAt
            }));

            return reply.status(200).send({ vouchers: formatted });
        } catch (err) {
            console.error('[Admin Vouchers GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_VOUCHERS_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_VOUCHERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_VOUCHERS permission.' });
            }

            let { code, credits, maxUses, expiryHours } = req.body || {};

            let parsedCredits = parseInt(credits, 10);
            if (isNaN(parsedCredits) || parsedCredits <= 0) {
                return reply.status(400).send({ error: 'Credits awarded must be a positive integer.' });
            }
            if (parsedCredits > 999999999) {
                parsedCredits = 999999999;
            }

            if (!code || typeof code !== 'string' || !code.trim()) {
                code = generateVoucherCode();
            } else {
                code = code.trim().toUpperCase();
            }

            const existing = await db.collection('vouchers').findOne({ code });
            if (existing) {
                return reply.status(409).send({ error: 'A voucher with this code already exists.' });
            }

            const parsedMaxUses = parseInt(maxUses, 10);
            const finalMaxUses = !isNaN(parsedMaxUses) && parsedMaxUses >= 0 ? parsedMaxUses : 0;

            let expiresAt = null;
            const parsedExpiryHours = parseInt(expiryHours, 10);
            if (!isNaN(parsedExpiryHours) && parsedExpiryHours > 0) {
                expiresAt = new Date(Date.now() + parsedExpiryHours * 3600 * 1000).toISOString();
            }

            const newVoucher = {
                id: generateVoucherId(),
                code,
                credits: parsedCredits,
                maxUses: finalMaxUses,
                usesCount: 0,
                expiresAt,
                createdAt: new Date().toISOString()
            };

            await db.collection('vouchers').insertOne(newVoucher);

            return reply.status(201).send({
                success: true,
                message: 'Voucher created successfully.',
                voucher: newVoucher
            });
        } catch (err) {
            console.error('[Admin Vouchers POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_VOUCHERS_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_VOUCHERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_VOUCHERS permission.' });
            }

            const { id, code, credits, maxUses, expiryHours, clearExpiry } = req.body || {};

            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Voucher ID is required.' });
            }

            const existing = await db.collection('vouchers').findOne({ id });
            if (!existing) {
                return reply.status(404).send({ error: 'Voucher not found.' });
            }

            const updateDoc = {};

            if (code && typeof code === 'string' && code.trim().toUpperCase() !== existing.code) {
                const newCode = code.trim().toUpperCase();
                const codeConflict = await db.collection('vouchers').findOne({ code: newCode, id: { $ne: id } });
                if (codeConflict) {
                    return reply.status(409).send({ error: 'Another voucher already uses this code.' });
                }
                updateDoc.code = newCode;
            }

            if (credits !== undefined) {
                let parsedCredits = parseInt(credits, 10);
                if (isNaN(parsedCredits) || parsedCredits <= 0) {
                    return reply.status(400).send({ error: 'Credits awarded must be a positive integer.' });
                }
                if (parsedCredits > 999999999) {
                    parsedCredits = 999999999;
                }
                updateDoc.credits = parsedCredits;
            }

            if (maxUses !== undefined) {
                const parsedMaxUses = parseInt(maxUses, 10);
                if (!isNaN(parsedMaxUses) && parsedMaxUses >= 0) {
                    updateDoc.maxUses = parsedMaxUses;
                }
            }

            if (clearExpiry) {
                updateDoc.expiresAt = null;
            } else if (expiryHours !== undefined && expiryHours !== '') {
                const parsedHours = parseInt(expiryHours, 10);
                if (!isNaN(parsedHours) && parsedHours > 0) {
                    updateDoc.expiresAt = new Date(Date.now() + parsedHours * 3600 * 1000).toISOString();
                }
            }

            if (Object.keys(updateDoc).length === 0) {
                return reply.status(400).send({ error: 'No changes provided.' });
            }

            await db.collection('vouchers').updateOne({ id }, { $set: updateDoc });

            return reply.status(200).send({ success: true, message: 'Voucher updated successfully.' });
        } catch (err) {
            console.error('[Admin Vouchers PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_VOUCHERS_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_VOUCHERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_VOUCHERS permission.' });
            }

            const { id } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Voucher ID is required.' });
            }

            const result = await db.collection('vouchers').deleteOne({ id });
            if (result.deletedCount === 0) {
                return reply.status(404).send({ error: 'Voucher not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Voucher deleted successfully.' });
        } catch (err) {
            console.error('[Admin Vouchers DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};