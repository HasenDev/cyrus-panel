const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'VOUCHER_REDEEM_POST', 10, 60000)) return;

            const { code } = req.body || {};
            if (!code || typeof code !== 'string' || !code.trim()) {
                return reply.status(400).send({ error: 'Voucher code is required.' });
            }

            const cleanCode = code.trim().toUpperCase();
            const db = getDB();

            const voucher = await db.collection('vouchers').findOne({ code: cleanCode });
            if (!voucher) {
                return reply.status(404).send({ error: 'Invalid or unrecognized voucher code.' });
            }

            if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
                return reply.status(400).send({ error: 'This voucher code has expired.' });
            }

            if (voucher.maxUses > 0 && voucher.usesCount >= voucher.maxUses) {
                return reply.status(400).send({ error: 'This voucher has reached its maximum redemptions.' });
            }

            const existingClaim = await db.collection('voucher_redemptions').findOne({
                voucherId: voucher.id,
                userId: req.userId
            });

            if (existingClaim) {
                return reply.status(409).send({ error: 'You have already claimed this voucher code.' });
            }

            await db.collection('voucher_redemptions').insertOne({
                voucherId: voucher.id,
                userId: req.userId,
                claimedAt: new Date().toISOString()
            });

            await db.collection('vouchers').updateOne(
                { id: voucher.id },
                { $inc: { usesCount: 1 } }
            );

            await db.collection('users').updateOne(
                { _id: req.userId },
                { $inc: { credits: voucher.credits } }
            );

            const txnId = `VOUCH-${Math.floor(10000 + Math.random() * 90000)}`;
            const newTxn = {
                id: txnId,
                userId: req.userId,
                credits: voucher.credits,
                amountUSD: 0,
                type: 'voucher',
                status: 'Completed',
                description: `Redeemed voucher ${voucher.code}`,
                createdAt: new Date().toISOString()
            };

            await db.collection('transactions').insertOne(newTxn);

            const updatedUser = await db.collection('users').findOne({ _id: req.userId });

            return reply.status(200).send({
                success: true,
                message: `Voucher redeemed! +${voucher.credits.toLocaleString()} Credits added.`,
                creditsAdded: voucher.credits,
                newBalance: updatedUser.credits || 0,
                transaction: {
                    id: newTxn.id,
                    date: new Date(newTxn.createdAt).toISOString().replace('T', ' ').substring(0, 16),
                    credits: newTxn.credits,
                    amountUSD: 0,
                    status: newTxn.status
                }
            });
        } catch (err) {
            console.error('[Redeem Voucher Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};