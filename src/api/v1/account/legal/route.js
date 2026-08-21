const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ACCOUNT_LEGAL_ACCEPT', 20, 60000)) return;

            const db = getDB();
            const now = Date.now();

            await db.collection('users').updateOne(
                { _id: req.userId },
                {
                    $set: {
                        acceptTosAndPrivacy: true,
                        acceptedTosAndPrivacyAt: now
                    }
                }
            );

            return reply.status(200).send({
                success: true,
                message: 'Legal terms and privacy policy successfully accepted.',
                acceptedTosAndPrivacyAt: now
            });
        } catch (err) {
            console.error('[Legal Agreement Accept Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};