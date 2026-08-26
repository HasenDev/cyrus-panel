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
    if (!fs.existsSync(ENV_PATH)) return {};
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
    } catch {
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

async function verifyOxaPayApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return { valid: false, error: 'OxaPay API Key cannot be empty.' };
    }

    const cleanKey = apiKey.trim();

    try {
        const response = await fetch('https://api.oxapay.com/v1/payment/accepted-currencies', {
            method: 'GET',
            headers: {
                'merchant_api_key': cleanKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        if (response.ok && (data.status === 200 || data.result === 100 || Array.isArray(data?.data?.list))) {
            return { valid: true };
        }

        const fallbackRes = await fetch('https://api.oxapay.com/merchant/allowedCoins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ merchant: cleanKey })
        });

        const fallbackData = await fallbackRes.json();
        if (fallbackRes.ok && (fallbackData.result === 100 || fallbackData.status === 200 || Array.isArray(fallbackData.allowedCoins))) {
            return { valid: true };
        }

        return { valid: false, error: data.message || fallbackData.message || 'Invalid OxaPay Merchant API Key.' };
    } catch {
        return { valid: false, error: 'Could not connect to OxaPay servers to verify API key.' };
    }
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            if (checkRateLimit(reply, req.userId, 'ADMIN_PAYMENT_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PAYMENT')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PAYMENT permission.' });
            }

            const env = readEnvFile();

            return reply.status(200).send({
                paymentsEnabled: env.PAYMENTS_ENABLED === 'true',
                providerOxapayEnabled: env.PROVIDER_OXAPAY_ENABLED === 'true',
                oxaPayApiKey: env.OXAPAY_API_KEY || '',
                providerApiCallbackEnabled: env.PROVIDER_API_CALLBACK_ENABLED === 'true',
                apiCallbackKey: env.API_CALLBACK_KEY || '',
                creditsPricePer10: env.CREDITS_PRICE_PER_10 || '0.20',
                defaultMaxDeployments: env.DEFAULT_MAX_DEPLOYMENTS || process.env.DEFAULT_MAX_DEPLOYMENTS || '10'
            });
        } catch (err) {
            console.error('[Admin Payment GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },

    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            if (checkRateLimit(reply, req.userId, 'ADMIN_PAYMENT_POST', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PAYMENT')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PAYMENT permission.' });
            }

            const body = req.body || {};
            const envUpdates = {};

            if (typeof body.paymentsEnabled === 'boolean') {
                envUpdates.PAYMENTS_ENABLED = body.paymentsEnabled ? 'true' : 'false';
            }

            if (typeof body.providerOxapayEnabled === 'boolean') {
                envUpdates.PROVIDER_OXAPAY_ENABLED = body.providerOxapayEnabled ? 'true' : 'false';
            }

            if (typeof body.oxaPayApiKey === 'string') {
                envUpdates.OXAPAY_API_KEY = body.oxaPayApiKey.trim();
            }

            if (typeof body.providerApiCallbackEnabled === 'boolean') {
                envUpdates.PROVIDER_API_CALLBACK_ENABLED = body.providerApiCallbackEnabled ? 'true' : 'false';
            }

            if (typeof body.apiCallbackKey === 'string') {
                envUpdates.API_CALLBACK_KEY = body.apiCallbackKey.trim();
            }

            if (body.creditsPricePer10 !== undefined) {
                const parsedPrice = parseFloat(body.creditsPricePer10);
                if (isNaN(parsedPrice) || parsedPrice <= 0) {
                    return reply.status(400).send({ error: 'Price per 10 credits must be a positive number.' });
                }
                envUpdates.CREDITS_PRICE_PER_10 = parsedPrice.toFixed(4);
            }

            if (body.defaultMaxDeployments !== undefined) {
                const parsedDeployments = parseInt(body.defaultMaxDeployments, 10);
                if (isNaN(parsedDeployments) || parsedDeployments < 1) {
                    return reply.status(400).send({ error: 'Default max deployments must be a positive integer (at least 1).' });
                }
                envUpdates.DEFAULT_MAX_DEPLOYMENTS = String(parsedDeployments);
            }

            const isOxapayEnabled = body.providerOxapayEnabled === true || (body.providerOxapayEnabled === undefined && process.env.PROVIDER_OXAPAY_ENABLED === 'true');
            const targetOxaPayKey = body.oxaPayApiKey !== undefined ? body.oxaPayApiKey : process.env.OXAPAY_API_KEY;

            if (isOxapayEnabled) {
                if (!targetOxaPayKey || !targetOxaPayKey.trim()) {
                    return reply.status(400).send({ error: 'An OxaPay Merchant API key is required when OxaPay provider is enabled.' });
                }

                const verification = await verifyOxaPayApiKey(targetOxaPayKey);
                if (!verification.valid) {
                    return reply.status(400).send({
                        error: `OxaPay Verification Failed: ${verification.error}`
                    });
                }
            }

            const isApiCallbackEnabled = body.providerApiCallbackEnabled === true || (body.providerApiCallbackEnabled === undefined && process.env.PROVIDER_API_CALLBACK_ENABLED === 'true');
            const targetApiKey = body.apiCallbackKey !== undefined ? body.apiCallbackKey : process.env.API_CALLBACK_KEY;

            if (isApiCallbackEnabled) {
                if (!targetApiKey || !targetApiKey.trim()) {
                    return reply.status(400).send({ error: 'An API Callback secret key is required when API Callback is enabled.' });
                }
            }

            if (Object.keys(envUpdates).length === 0) {
                return reply.status(400).send({ error: 'No valid payment fields provided.' });
            }

            updateEnvFile(envUpdates);

            return reply.status(200).send({
                success: true,
                message: 'Settings validated and saved successfully.'
            });
        } catch (err) {
            console.error('[Admin Payment POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
