const fs = require('fs');
const path = require('path');
const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { getAccessLevel } = require('../../../../lib/permissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function getEnvPath() {
    const candidates = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(__dirname, '../../../../.env'),
        path.resolve(__dirname, '../../../.env'),
        path.resolve(__dirname, '../../.env'),
        path.resolve(__dirname, '../.env')
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function readEnvFile() {
    const envPath = getEnvPath();
    if (!envPath) return {};
    try {
        const content = fs.readFileSync(envPath, 'utf8');
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
                    process.env[key] = val;
                }
            }
        });
        return envObj;
    } catch {
        return {};
    }
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            if (checkRateLimit(reply, req.userId, 'ACCOUNT_ME_GET', 120, 60000)) return;

            const env = readEnvFile();
            const db = getDB();

            const user = await db.collection('users').findOne(
                { _id: req.userId },
                { projection: { password: 0 } }
            );

            if (!user) {
                return reply.status(404).send({ error: 'User record not found.' });
            }

            const avatarUrl = user.avatarUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${user._id}`;

            const userServers = await db.collection('servers').find({
                $or: [
                    { ownerId: user._id },
                    { ownerId: String(user._id) }
                ]
            }).toArray();

            const nodeIds = [...new Set(userServers.map(s => s.nodeId).filter(Boolean))];
            const nodes = await db.collection('nodes').find({ id: { $in: nodeIds } }).toArray();

            let onlineServers = 0;

            await Promise.all(userServers.map(async (server) => {
                const node = nodes.find(n => n.id === server.nodeId);
                const isSuspended = Boolean(server.suspended);

                let liveStatus = server.installing
                    ? 'installing'
                    : isSuspended
                    ? 'suspended'
                    : (server.status || 'offline');

                if (!server.installing && !isSuspended && node) {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 1800);
                        const daemonRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${server.id}`, {
                            method: 'GET',
                            headers: { Authorization: `Bearer ${node.daemonKey}` },
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);

                        if (daemonRes.ok) {
                            const statusData = await daemonRes.json();
                            liveStatus = statusData.status || liveStatus;
                        }
                    } catch {}
                }

                if (liveStatus === 'running' || liveStatus === 'online') {
                    onlineServers++;
                }
            }));

            const deployments = userServers.length;
            const envMaxDeployments = parseInt(env.DEFAULT_MAX_DEPLOYMENTS || process.env.DEFAULT_MAX_DEPLOYMENTS, 10) || 10;
            const maxDeployments = user.maxDeployments !== undefined && user.maxDeployments !== null
                ? parseInt(user.maxDeployments, 10)
                : envMaxDeployments;

            const legalSettings = await db.collection('settings').findOne({ _id: 'legal_settings' });
            const panelSettings = await db.collection('settings').findOne({ _id: 'panel_settings' });

            let requiresLegalAcceptance = false;
            if (legalSettings && legalSettings.enabled) {
                const tosUpdated = legalSettings.tosUpdatedAt || 0;
                const privacyUpdated = legalSettings.privacyUpdatedAt || 0;
                const latestLegalTimestamp = Math.max(tosUpdated, privacyUpdated);

                if (latestLegalTimestamp > 0) {
                    const rawUserTimestamp = user.acceptedTosAndPrivacyAt;
                    let userAcceptedTimestamp = 0;
                    if (typeof rawUserTimestamp === 'number') {
                        userAcceptedTimestamp = rawUserTimestamp;
                    } else if (rawUserTimestamp) {
                        userAcceptedTimestamp = new Date(rawUserTimestamp).getTime();
                    }
                    if (userAcceptedTimestamp < latestLegalTimestamp) {
                        requiresLegalAcceptance = true;
                    }
                }
            }

            const responsePayload = {
                id: user._id,
                email: user.email,
                username: user.username,
                avatarUrl: avatarUrl,
                permissions: getPermissions(user),
                accessLevel: getAccessLevel(user),
                admin: !!user.admin,
                bot: !!user.bot,
                createdAt: user.createdAt,
                requiresLegalAcceptance,
                acceptedTosAndPrivacyAt: user.acceptedTosAndPrivacyAt || null,
                accentColor: env.ACCENT_COLOR || process.env.ACCENT_COLOR || '#00f2fe',
                panel: {
                    name: env.PANEL_NAME || process.env.PANEL_NAME || 'Cyrus Panel',
                    description: env.PANEL_DESCRIPTION || process.env.PANEL_DESCRIPTION || 'High-performance cloud compute and service management panel.',
                    icon: env.PANEL_ICON !== undefined ? env.PANEL_ICON : (process.env.PANEL_ICON || ''),
                    websiteUrl: panelSettings?.websiteUrl || '',
                    discordUrl: panelSettings?.discordUrl || ''
                },
                metrics: {
                    credits: user.credits || 0,
                    deployments: deployments,
                    maxDeployments: maxDeployments,
                    onlineServers: onlineServers
                }
            };

            const announcement = await db.collection('announcements').findOne({}, { sort: { createdAt: -1 } });
            responsePayload.newsletter = announcement ? {
                title: announcement.title,
                description: announcement.description,
                image: announcement.image || null
            } : null;

            return reply.status(200).send(responsePayload);
        } catch (err) {
            console.error('[Account Me Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};