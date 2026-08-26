const crypto = require('crypto');
const { getDB, getClient } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { checkRateLimit } = require('../../../../lib/rateLimit');

let indexEnsured = false;

async function ensureVoucherIndex(db) {
    if (indexEnsured) return;
    try {
        await db.collection('voucher_redemptions').createIndex(
            { voucherId: 1, userId: 1 },
            { unique: true }
        );
        indexEnsured = true;
    } catch {}
}

function isDuplicateKeyError(err) {
    return Boolean(
        err &&
        (err.code === 11000 ||
         err.codeName === 'DuplicateKey' ||
         (typeof err.message === 'string' && err.message.includes('E11000')))
    );
}

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

            await ensureVoucherIndex(db);

            const voucher = await db.collection('vouchers').findOne({ code: cleanCode });
            if (!voucher) {
                return reply.status(404).send({ error: 'Invalid or unrecognized voucher code.' });
            }

            if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
                return reply.status(400).send({ error: 'This voucher code has expired.' });
            }

            const existingClaim = await db.collection('voucher_redemptions').findOne({
                voucherId: voucher.id,
                userId: req.userId
            });

            if (existingClaim) {
                return reply.status(409).send({ error: 'You have already claimed this voucher code.' });
            }

            const nowIso = new Date().toISOString();
            const txnId = `VOUCH-${crypto.randomInt(10000, 100000)}`;
            const newTxn = {
                id: txnId,
                userId: req.userId,
                credits: voucher.credits,
                amountUSD: 0,
                type: 'voucher',
                status: 'Completed',
                description: `Redeemed voucher ${voucher.code}`,
                createdAt: nowIso
            };

            const client = (typeof getClient === 'function' ? getClient() : null) || db.client || db.s?.client;
            let session = null;

            if (client && typeof client.startSession === 'function') {
                try {
                    session = client.startSession();
                } catch {}
            }

            if (session) {
                try {
                    await session.withTransaction(async () => {
                        const inTxnClaim = await db.collection('voucher_redemptions').findOne(
                            { voucherId: voucher.id, userId: req.userId },
                            { session }
                        );
                        if (inTxnClaim) {
                            const err = new Error('ALREADY_CLAIMED');
                            err.code = 'ALREADY_CLAIMED';
                            throw err;
                        }

                        const result = await db.collection('vouchers').findOneAndUpdate(
                            {
                                id: voucher.id,
                                $or: [
                                    { maxUses: 0 },
                                    { maxUses: { $lte: 0 } },
                                    { $expr: { $lt: [{ $ifNull: ['$usesCount', 0] }, '$maxUses'] } }
                                ]
                            },
                            { $inc: { usesCount: 1 } },
                            { returnDocument: 'after', session }
                        );

                        const updatedVoucher = (result && typeof result === 'object' && 'value' in result) ? result.value : result;
                        if (!updatedVoucher) {
                            const err = new Error('MAX_USES_REACHED');
                            err.code = 'MAX_USES_REACHED';
                            throw err;
                        }

                        await db.collection('voucher_redemptions').insertOne(
                            {
                                voucherId: voucher.id,
                                userId: req.userId,
                                claimedAt: nowIso
                            },
                            { session }
                        );

                        await db.collection('users').updateOne(
                            { _id: req.userId },
                            { $inc: { credits: voucher.credits } },
                            { session }
                        );

                        await db.collection('transactions').insertOne(newTxn, { session });
                    });
                } catch (txnErr) {
                    if (txnErr.code === 'ALREADY_CLAIMED' || isDuplicateKeyError(txnErr)) {
                        return reply.status(409).send({ error: 'You have already claimed this voucher code.' });
                    }
                    if (txnErr.code === 'MAX_USES_REACHED') {
                        return reply.status(400).send({ error: 'This voucher has reached its maximum redemptions.' });
                    }
                    if (
                        txnErr.message?.includes('replica set') ||
                        txnErr.message?.includes('Transaction numbers') ||
                        txnErr.code === 20
                    ) {
                        session = null;
                    } else {
                        throw txnErr;
                    }
                } finally {
                    if (session) {
                        await session.endSession().catch(() => {});
                    }
                }
            }

            if (!session) {
                try {
                    await db.collection('voucher_redemptions').insertOne({
                        voucherId: voucher.id,
                        userId: req.userId,
                        claimedAt: nowIso
                    });
                } catch (claimErr) {
                    if (isDuplicateKeyError(claimErr)) {
                        return reply.status(409).send({ error: 'You have already claimed this voucher code.' });
                    }
                    throw claimErr;
                }

                const result = await db.collection('vouchers').findOneAndUpdate(
                    {
                        id: voucher.id,
                        $or: [
                            { maxUses: 0 },
                            { maxUses: { $lte: 0 } },
                            { $expr: { $lt: [{ $ifNull: ['$usesCount', 0] }, '$maxUses'] } }
                        ]
                    },
                    { $inc: { usesCount: 1 } },
                    { returnDocument: 'after' }
                );

                const updatedVoucher = (result && typeof result === 'object' && 'value' in result) ? result.value : result;
                if (!updatedVoucher) {
                    await db.collection('voucher_redemptions').deleteOne({
                        voucherId: voucher.id,
                        userId: req.userId
                    });
                    return reply.status(400).send({ error: 'This voucher has reached its maximum redemptions.' });
                }

                await db.collection('users').updateOne(
                    { _id: req.userId },
                    { $inc: { credits: voucher.credits } }
                );

                await db.collection('transactions').insertOne(newTxn);
            }

            const updatedUser = await db.collection('users').findOne({ _id: req.userId });

            return reply.status(200).send({
                success: true,
                message: `Voucher redeemed! +${voucher.credits.toLocaleString()} Credits added.`,
                creditsAdded: voucher.credits,
                newBalance: updatedUser?.credits || 0,
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
