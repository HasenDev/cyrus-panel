const crypto = require('crypto');
const { getDB } = require('../../../../../lib/db');

function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }

    try {
        const bufA = Buffer.from(a, 'utf8');
        const bufB = Buffer.from(b, 'utf8');

        if (bufA.length !== bufB.length) {
            return false;
        }

        return crypto.timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

function verifyHmacSignature(rawBody, signature, secretKey) {
    if (!rawBody || !signature || !secretKey) {
        return false;
    }

    try {
        const rawBuffer = Buffer.isBuffer(rawBody)
            ? rawBody
            : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody)
            : Buffer.from(String(rawBody), 'utf8');

        if (rawBuffer.length === 0) {
            return false;
        }

        const calculated = crypto
            .createHmac('sha512', secretKey)
            .update(rawBuffer)
            .digest('hex');

        const received = String(signature).trim().toLowerCase();
        return timingSafeCompare(calculated, received);
    } catch {
        return false;
    }
}

function normalizeId(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

function idsMatch(a, b) {
    const left = normalizeId(a);
    const right = normalizeId(b);

    if (!left || !right) return true;
    return left === right;
}

async function findTransaction(db, orderId, trackId) {
    const transactions = db.collection('transactions');

    if (orderId) {
        const txn = await transactions.findOne({
            $or: [{ orderId }, { id: orderId }]
        });
        if (txn) return txn;
    }

    if (trackId) {
        const numericTrackId = Number(trackId);
        const trackCandidates = [{ trackId }];

        if (Number.isSafeInteger(numericTrackId)) {
            trackCandidates.push({ trackId: numericTrackId });
        }

        const txn = await transactions.findOne({ $or: trackCandidates });
        if (txn) return txn;
    }

    return null;
}

async function completeTransaction(db, txn, trackId, orderId, paidAmount, paidCurrency) {
    if (!db) {
        throw new Error('MongoDB Db instance is missing');
    }

    const transactions = db.collection('transactions');
    const users = db.collection('users');

    const currentTransaction = await transactions.findOne({
        _id: txn._id,
        status: 'Pending'
    });

    if (!currentTransaction) {
        return false;
    }

    if (trackId && currentTransaction.trackId !== undefined && !idsMatch(currentTransaction.trackId, trackId)) {
        throw new Error(`Transaction track ID mismatch: stored=${String(currentTransaction.trackId)} received=${String(trackId)}`);
    }

    if (orderId && currentTransaction.orderId !== undefined && !idsMatch(currentTransaction.orderId, orderId)) {
        throw new Error(`Transaction order ID mismatch: stored=${String(currentTransaction.orderId)} received=${String(orderId)}`);
    }

    const expectedAmount = Number(currentTransaction.amount ?? currentTransaction.price);
    if (Number.isFinite(expectedAmount) && expectedAmount > 0) {
        const received = Number(paidAmount);
        if (!Number.isFinite(received) || received < expectedAmount) {
            throw new Error(`Transaction amount mismatch: expected=${expectedAmount} received=${received}`);
        }
    }

    if (currentTransaction.currency && paidCurrency) {
        const expectedCurrency = String(currentTransaction.currency).trim().toUpperCase();
        const receivedCurrency = String(paidCurrency).trim().toUpperCase();
        if (expectedCurrency !== receivedCurrency) {
            throw new Error(`Transaction currency mismatch: expected=${expectedCurrency} received=${receivedCurrency}`);
        }
    }

    const creditAmount = Number(currentTransaction.credits);
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
        throw new Error(`Invalid transaction credit amount: ${String(currentTransaction.credits)}`);
    }

    if (!currentTransaction.userId) {
        throw new Error('Transaction has no userId');
    }

    const updateData = {
        status: 'Completed',
        paidAmount: Number(paidAmount) || expectedAmount || 0,
        paidCurrency: paidCurrency || currentTransaction.currency || null,
        updatedAt: new Date().toISOString()
    };

    if (trackId) updateData.trackId = trackId;
    if (orderId && currentTransaction.orderId === undefined) updateData.orderId = orderId;

    const updateResult = await transactions.updateOne(
        { _id: currentTransaction._id, status: 'Pending' },
        { $set: updateData }
    );

    if (updateResult.modifiedCount !== 1) {
        return false;
    }

    const userUpdateResult = await users.updateOne(
        { _id: currentTransaction.userId },
        { $inc: { credits: creditAmount } }
    );

    if (userUpdateResult.matchedCount !== 1) {
        throw new Error(`Transaction user was not found: ${currentTransaction.userId}`);
    }

    return true;
}

module.exports = {
    POST: async (req, reply) => {
        const requestId = crypto.randomUUID();

        try {
            const apiKey = process.env.OXAPAY_API_KEY;

            if (!apiKey) {
                console.error('[OxaPay Relay Error] OXAPAY_API_KEY is missing');
                return reply.status(500).send('ok');
            }

            const rawBody = req.rawBody;

            if (!rawBody) {
                console.error(`[OxaPay Relay Error] ${requestId} req.rawBody is missing`);
                return reply.status(400).send('ok');
            }

            const hmacHeader = req.headers?.hmac ?? req.headers?.['x-hmac'] ?? null;

            if (typeof hmacHeader !== 'string' || !hmacHeader.trim()) {
                console.error(`[OxaPay Relay Error] ${requestId} HMAC header missing`);
                return reply.status(400).send('ok');
            }

            const signatureValid = verifyHmacSignature(rawBody, hmacHeader, apiKey);

            if (!signatureValid) {
                console.error(`[OxaPay Relay Error] ${requestId} invalid HMAC signature`);
                return reply.status(400).send('ok');
            }

            const body = req.body;

            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                console.error(`[OxaPay Relay Error] ${requestId} invalid parsed body`);
                return reply.status(400).send('ok');
            }

            const type = String(body.type ?? '').trim().toLowerCase();
            const status = String(body.status ?? '').trim().toLowerCase();
            const orderId = normalizeId(body.order_id);
            const trackId = normalizeId(body.track_id);
            const paidAmount = body.amount ?? body.pay_amount ?? null;
            const paidCurrency = body.currency ?? body.pay_currency ?? null;

            if (type !== 'invoice') {
                return reply.status(200).send('ok');
            }

            if (!orderId && !trackId) {
                console.error(`[OxaPay Relay Error] ${requestId} webhook has neither order_id nor track_id`);
                return reply.status(400).send('ok');
            }

            if (status !== 'paid') {
                return reply.status(200).send('ok');
            }

            const db = getDB();
            const txn = await findTransaction(db, orderId, trackId);

            if (!txn) {
                console.error(`[OxaPay Relay Error] ${requestId} no matching transaction`);
                return reply.status(200).send('ok');
            }

            if (txn.status === 'Completed' || txn.status !== 'Pending') {
                return reply.status(200).send('ok');
            }

            if (trackId && txn.trackId !== undefined && !idsMatch(txn.trackId, trackId)) {
                console.error(`[OxaPay Relay Error] ${requestId} track ID mismatch`);
                return reply.status(200).send('ok');
            }

            if (orderId && txn.orderId !== undefined && !idsMatch(txn.orderId, orderId)) {
                console.error(`[OxaPay Relay Error] ${requestId} order ID mismatch`);
                return reply.status(200).send('ok');
            }

            const expectedAmount = Number(txn.amount ?? txn.price);
            if (Number.isFinite(expectedAmount) && expectedAmount > 0) {
                const received = Number(paidAmount);
                if (!Number.isFinite(received) || received < expectedAmount) {
                    console.error(`[OxaPay Relay Error] ${requestId} underpayment or invalid amount: expected=${expectedAmount} received=${received}`);
                    return reply.status(400).send('ok');
                }
            }

            if (txn.currency && paidCurrency) {
                const expectedCurrency = String(txn.currency).trim().toUpperCase();
                const receivedCurrency = String(paidCurrency).trim().toUpperCase();
                if (expectedCurrency !== receivedCurrency) {
                    console.error(`[OxaPay Relay Error] ${requestId} currency mismatch: expected=${expectedCurrency} received=${receivedCurrency}`);
                    return reply.status(400).send('ok');
                }
            }

            await completeTransaction(db, txn, trackId, orderId, paidAmount, paidCurrency);

            return reply.status(200).send('ok');
        } catch (err) {
            console.error(`[OxaPay Relay Error] ${requestId}:`, err);
            return reply.status(500).send('Internal server error');
        }
    }
};
