const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'OXAPAY_CHECKOUT_POST', 10, 60000)) return;

            if (process.env.PAYMENTS_ENABLED !== 'true') {
                return reply.status(400).send({
                    error: 'Payment gateway is currently disabled.'
                });
            }

            const apiKey = process.env.OXAPAY_API_KEY;

            if (process.env.PROVIDER_OXAPAY_ENABLED !== 'true' || !apiKey) {
                return reply.status(400).send({
                    error: 'OxaPay payment provider is not configured.'
                });
            }

            const { amountUSD } = req.body || {};
            const parsedAmount = Number.parseFloat(amountUSD);

            if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
                return reply.status(400).send({
                    error: 'Minimum purchase amount is $1.00 USD.'
                });
            }

            const db = getDB();

            const user = await db.collection('users').findOne({
                _id: req.userId
            });

            if (!user) {
                return reply.status(404).send({
                    error: 'User not found.'
                });
            }

            const pricePer10 = Number.parseFloat(
                process.env.CREDITS_PRICE_PER_10 || '0.20'
            );

            const creditsToAward = Math.floor(
                (parsedAmount / (pricePer10 > 0 ? pricePer10 : 0.20)) * 10
            );

            const orderId = `OXA-${Date.now()}-${Math.floor(
                Math.random() * 100000
            )}`;

            const baseUrl = (
                process.env.API_URL ||
                process.env.APP_URL ||
                'https://cyrusapi.admibot.xyz'
            ).replace(/\/+$/, '');

            const callbackUrl = `${baseUrl}/api/v1/payment/oxapay/relay`;
            const returnUrl = `${baseUrl}/home/credits`;
            const isSandbox = process.env.OXAPAY_SANDBOX === 'true';

            const payload = {
                amount: parsedAmount,
                currency: 'USD',
                lifetime: 30,
                callback_url: callbackUrl,
                return_url: returnUrl,
                order_id: orderId,
                description: `Purchase ${creditsToAward.toLocaleString()} Credits`,
                sandbox: false
            };

            const oxaRes = await fetch(
                'https://api.oxapay.com/v1/payment/invoice',
                {
                    method: 'POST',
                    headers: {
                        'merchant_api_key': apiKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                }
            );

            const responseText = await oxaRes.text();
            let oxaData;

            try {
                oxaData = JSON.parse(responseText);
            } catch {
                return reply.status(502).send({
                    error: 'Invalid response from OxaPay.'
                });
            }

            if (!oxaRes.ok) {
                return reply.status(400).send({
                    error:
                        oxaData?.message ||
                        oxaData?.error ||
                        'OxaPay rejected the invoice request.'
                });
            }

            const data = oxaData?.data || {};

            const payUrl =
                data.payment_url ||
                data.payLink ||
                data.pay_link ||
                oxaData.payment_url ||
                oxaData.payLink ||
                oxaData.pay_link ||
                null;

            const trackId =
                data.track_id ??
                data.trackId ??
                oxaData.track_id ??
                oxaData.trackId ??
                null;

            if (!payUrl) {
                return reply.status(502).send({
                    error: 'OxaPay did not return a valid payment URL.'
                });
            }

            if (!trackId) {
                return reply.status(502).send({
                    error: 'OxaPay did not return a valid track ID.'
                });
            }

            const numericTrackId = Number.parseInt(trackId, 10);

            await db.collection('transactions').insertOne({
                id: orderId,
                trackId: Number.isFinite(numericTrackId)
                    ? numericTrackId
                    : String(trackId),
                userId: req.userId,
                amountUSD: parsedAmount,
                credits: creditsToAward,
                type: 'oxapay',
                status: 'Pending',
                isSandbox,
                description: `OxaPay $${parsedAmount.toFixed(2)} USD`,
                createdAt: new Date().toISOString()
            });

            return reply.status(200).send({
                success: true,
                payUrl,
                orderId,
                trackId
            });

        } catch (err) {
            console.error('[Credits Checkout Error]:', err);
            return reply.status(500).send({
                error: err.message || 'Internal server error'
            });
        }
    }
};
