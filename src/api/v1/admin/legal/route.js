const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_LEGAL_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SETTINGS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SETTINGS permission.' });
            }

            const doc = await db.collection('settings').findOne({ _id: 'legal_settings' });

            return reply.status(200).send({
                enabled: doc ? Boolean(doc.enabled) : false,
                tos: doc ? (doc.tos || '') : '',
                privacy: doc ? (doc.privacy || '') : '',
                tosUpdatedAt: doc ? (doc.tosUpdatedAt || null) : null,
                privacyUpdatedAt: doc ? (doc.privacyUpdatedAt || null) : null
            });
        } catch (err) {
            console.error('[Admin Legal GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_LEGAL_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SETTINGS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SETTINGS permission.' });
            }

            const { enabled, tos, privacy } = req.body || {};
            const existing = await db.collection('settings').findOne({ _id: 'legal_settings' });

            const currentEnabled = existing ? Boolean(existing.enabled) : false;
            const currentTos = existing ? (existing.tos || '') : '';
            const currentPrivacy = existing ? (existing.privacy || '') : '';
            const currentTosUpdatedAt = existing ? (existing.tosUpdatedAt || null) : null;
            const currentPrivacyUpdatedAt = existing ? (existing.privacyUpdatedAt || null) : null;

            const updateDoc = {};
            const now = Date.now();

            if (enabled !== undefined) {
                updateDoc.enabled = Boolean(enabled);
            }

            if (tos !== undefined && typeof tos === 'string') {
                const trimmedTos = tos.trim();
                updateDoc.tos = trimmedTos;
                if (trimmedTos !== currentTos.trim()) {
                    updateDoc.tosUpdatedAt = now;
                }
            }

            if (privacy !== undefined && typeof privacy === 'string') {
                const trimmedPrivacy = privacy.trim();
                updateDoc.privacy = trimmedPrivacy;
                if (trimmedPrivacy !== currentPrivacy.trim()) {
                    updateDoc.privacyUpdatedAt = now;
                }
            }

            await db.collection('settings').updateOne(
                { _id: 'legal_settings' },
                { $set: updateDoc },
                { upsert: true }
            );

            const latestDoc = await db.collection('settings').findOne({ _id: 'legal_settings' });

            return reply.status(200).send({
                success: true,
                message: 'Legal settings updated successfully.',
                enabled: latestDoc ? Boolean(latestDoc.enabled) : currentEnabled,
                tos: latestDoc ? (latestDoc.tos || '') : currentTos,
                privacy: latestDoc ? (latestDoc.privacy || '') : currentPrivacy,
                tosUpdatedAt: latestDoc ? (latestDoc.tosUpdatedAt || null) : currentTosUpdatedAt,
                privacyUpdatedAt: latestDoc ? (latestDoc.privacyUpdatedAt || null) : currentPrivacyUpdatedAt
            });
        } catch (err) {
            console.error('[Admin Legal PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};