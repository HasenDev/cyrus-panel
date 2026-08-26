const fs = require('fs');
const path = require('path');
const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

const ENV_PATH = path.resolve(__dirname, '../../../../../.env');

const ALLOWED_ENV_KEYS = new Set([
    'PANEL_NAME',
    'PANEL_DESCRIPTION',
    'PANEL_ICON',
    'ACCENT_COLOR',
    'RECAPTCHA_PUBLIC_KEY',
    'RECAPTCHA_SECRET_KEY',
    'RECAPTCHA_ENABLED',
    'RESEND_API_KEY',
    'EMAIL_ENABLED',
    'PAYMENTS_ENABLED',
    'PROVIDER_OXAPAY_ENABLED',
    'OXAPAY_API_KEY',
    'PROVIDER_API_CALLBACK_ENABLED',
    'API_CALLBACK_KEY',
    'CREDITS_PRICE_PER_10',
    'DEFAULT_MAX_DEPLOYMENTS'
]);

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
        console.error('[Settings] Error reading .env file:', err);
        return {};
    }
}

function updateEnvFile(newVars) {
    if (!newVars || typeof newVars !== 'object') return;

    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    let lines = content.split(/\r?\n/);

    Object.keys(newVars).forEach(key => {
        if (!ALLOWED_ENV_KEYS.has(key)) return;

        const val = String(newVars[key]).replace(/[\r\n]/g, '');
        const formattedVal = val.includes(' ') || val.includes('#') || val.includes('"')
            ? `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
            : val;

        let found = false;
        lines = lines.map(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                    const k = trimmed.substring(0, eqIdx).trim();
                    if (k === key) {
                        found = true;
                        return `${key}=${formattedVal}`;
                    }
                }
            }
            return line;
        });

        if (!found) {
            lines.push(`${key}=${formattedVal}`);
        }

        process.env[key] = val;
    });

    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SETTINGS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SETTINGS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SETTINGS permission.' });
            }

            const env = readEnvFile();
            const panelSettingsDoc = await db.collection('settings').findOne({ _id: 'panel_settings' });

            return reply.status(200).send({
                panelName: env.PANEL_NAME || 'Cyrus Panel',
                panelDescription: env.PANEL_DESCRIPTION || 'High-performance cloud compute and service management panel.',
                panelIcon: env.PANEL_ICON || '',
                websiteUrl: panelSettingsDoc?.websiteUrl || '',
                discordUrl: panelSettingsDoc?.discordUrl || '',
                accentColor: env.ACCENT_COLOR || '#00f2fe',
                recaptchaPublicKey: env.RECAPTCHA_PUBLIC_KEY || '',
                recaptchaSecretKey: env.RECAPTCHA_SECRET_KEY || '',
                recaptchaEnabled: env.RECAPTCHA_ENABLED === 'true',
                resendApiKey: env.RESEND_API_KEY || '',
                resendEnabled: env.EMAIL_ENABLED === 'true'
            });
        } catch (err) {
            console.error('[Admin Settings GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SETTINGS_POST', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SETTINGS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SETTINGS permission.' });
            }

            const body = req.body || {};
            const envUpdates = {};
            const dbUpdates = {};

            if (typeof body.panelName === 'string') envUpdates.PANEL_NAME = body.panelName.trim();
            if (typeof body.panelDescription === 'string') envUpdates.PANEL_DESCRIPTION = body.panelDescription.trim();
            if (typeof body.panelIcon === 'string') envUpdates.PANEL_ICON = body.panelIcon.trim();
            if (typeof body.accentColor === 'string') envUpdates.ACCENT_COLOR = body.accentColor.trim();
            if (typeof body.recaptchaPublicKey === 'string') envUpdates.RECAPTCHA_PUBLIC_KEY = body.recaptchaPublicKey.trim();
            if (typeof body.recaptchaSecretKey === 'string') envUpdates.RECAPTCHA_SECRET_KEY = body.recaptchaSecretKey.trim();
            if (typeof body.recaptchaEnabled === 'boolean') envUpdates.RECAPTCHA_ENABLED = body.recaptchaEnabled ? 'true' : 'false';
            if (typeof body.resendApiKey === 'string') envUpdates.RESEND_API_KEY = body.resendApiKey.trim();
            if (typeof body.resendEnabled === 'boolean') envUpdates.EMAIL_ENABLED = body.resendEnabled ? 'true' : 'false';

            if (typeof body.websiteUrl === 'string') {
                dbUpdates.websiteUrl = body.websiteUrl.trim();
            }
            if (typeof body.discordUrl === 'string') {
                dbUpdates.discordUrl = body.discordUrl.trim();
            }

            if (Object.keys(envUpdates).length === 0 && Object.keys(dbUpdates).length === 0) {
                return reply.status(400).send({ error: 'No valid setting fields provided.' });
            }

            if (Object.keys(envUpdates).length > 0) {
                updateEnvFile(envUpdates);
            }

            if (Object.keys(dbUpdates).length > 0) {
                await db.collection('settings').updateOne(
                    { _id: 'panel_settings' },
                    { $set: dbUpdates },
                    { upsert: true }
                );
            }

            return reply.status(200).send({ success: true, message: 'Settings saved successfully.' });
        } catch (err) {
            console.error('[Admin Settings POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
