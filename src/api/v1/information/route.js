const fs = require('fs');
const path = require('path');
const { getDB } = require('../../../lib/db');

const ENV_PATH = path.resolve(__dirname, '../../../../.env');

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) {
        return {};
    }
    try {
        const content = fs.readFileSync(ENV_PATH, 'utf8');
        const envObj = {};
        content.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                    const key = trimmed.substring(0, eqIdx).trim();
                    let val = trimmed.substring(eqIdx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    envObj[key] = val;
                }
            }
        });
        return envObj;
    } catch (err) {
        return {};
    }
}

module.exports = {
    rateLimit: {
        max: 120,
        timeWindow: '1 minute'
    },
    GET: async (req, reply) => {
        try {
            const env = readEnvFile();
            const db = getDB();

            const name = env.PANEL_NAME || process.env.PANEL_NAME || 'Cyrus Panel';
            const description = env.PANEL_DESCRIPTION || process.env.PANEL_DESCRIPTION || 'High-performance cloud compute and service management panel.';
            const icon = env.PANEL_ICON || process.env.PANEL_ICON || '';
            const accentColor = env.ACCENT_COLOR || process.env.ACCENT_COLOR || '#00f2fe';

            const emailEnabled = (env.EMAIL_ENABLED !== undefined ? env.EMAIL_ENABLED : process.env.EMAIL_ENABLED) === 'true';
            const recaptchaEnabled = (env.RECAPTCHA_ENABLED !== undefined ? env.RECAPTCHA_ENABLED : process.env.RECAPTCHA_ENABLED) === 'true';
            const recaptchaPublicKey = env.RECAPTCHA_PUBLIC_KEY || process.env.RECAPTCHA_PUBLIC_KEY || '';

            let customLegal = false;
            let tos = null;
            let privacy = null;
            let tosUpdatedAt = null;
            let privacyUpdatedAt = null;

            try {
                const legalDoc = await db.collection('settings').findOne({ _id: 'legal_settings' });
                if (legalDoc && legalDoc.enabled) {
                    customLegal = true;
                    tos = legalDoc.tos || '';
                    privacy = legalDoc.privacy || '';
                    tosUpdatedAt = legalDoc.tosUpdatedAt || null;
                    privacyUpdatedAt = legalDoc.privacyUpdatedAt || null;
                }
            } catch (dbErr) {
                console.error('[Information API Legal Fetch Error]:', dbErr);
            }

            return reply.status(200).send({
                name,
                description,
                icon,
                accentColor,
                emailEnabled,
                recaptchaEnabled,
                recaptchaPublicKey,
                customLegal,
                tos,
                privacy,
                tosUpdatedAt,
                privacyUpdatedAt
            });
        } catch (err) {
            console.error('[Information API Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};