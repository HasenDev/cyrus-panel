const { getDB } = require('../../../lib/db');
const { authenticate } = require('../../../lib/auth');
const { checkRateLimit } = require('../../../lib/rateLimit');

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            if (checkRateLimit(reply, req.userId, 'CLIENT_CREDITS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const transactions = await db.collection('transactions')
                .find({ userId: req.userId })
                .sort({ createdAt: -1 })
                .limit(25)
                .toArray();

            const formattedTxns = transactions.map(t => ({
                id: t.id || t._id.toString(),
                date: t.createdAt ? new Date(t.createdAt).toISOString().replace('T', ' ').substring(0, 16) : 'N/A',
                credits: typeof t.credits === 'number' ? t.credits : 0,
                amountUSD: typeof t.amountUSD === 'number' ? t.amountUSD : 0,
                type: t.type || 'payment',
                description: t.description || '',
                status: t.status || 'Completed'
            }));
            const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';
            const providerOxapayEnabled = process.env.PROVIDER_OXAPAY_ENABLED === 'true' && !!process.env.OXAPAY_API_KEY;
            const externalCreditsStoreUrl = process.env.EXTERNAL_CREDITS_STORE_URL?.trim() || null;
            const parsedPricePer10 = parseFloat(process.env.CREDITS_PRICE_PER_10 || '0.20');
            const pricePer10 = !isNaN(parsedPricePer10) && parsedPricePer10 > 0 ? parsedPricePer10 : 0.20;
            const creditsPerDollar = Math.floor(10 / pricePer10);
            const userCredits = typeof user.credits === 'number' ? user.credits : 0;

            
            return reply.status(200).send({
                credits: userCredits,
                paymentsEnabled,
                providerOxapayEnabled,
                externalCreditsStoreUrl,
                creditsPricePer10: pricePer10,
                creditsPerDollar,
                transactions: formattedTxns
            });
        } catch (err) {
            console.error('[Credits GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
