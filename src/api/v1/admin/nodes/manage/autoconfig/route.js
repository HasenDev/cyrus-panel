const crypto = require('crypto');
const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { getPermissions } = require('../../../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');

module.exports = {
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_AUTOCONFIG_CREATE', 10, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NODES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NODES permission.' });
            }

            const { nodeId } = req.body || {};
            if (!nodeId) return reply.status(400).send({ error: 'Node ID is required.' });

            const node = await db.collection('nodes').findOne({ id: nodeId });
            if (!node) return reply.status(404).send({ error: 'Node not found.' });

            const deployToken = crypto.randomBytes(24).toString('hex');
            const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

            await db.collection('node_tokens').insertOne({
                token: deployToken,
                nodeId,
                expiresAt,
                used: false,
                createdAt: new Date().toISOString()
            });

            const command = `sudo cyrus-daemon configure --panel-url https://${req.headers.host} --token ${deployToken}`;

            return reply.status(200).send({
                success: true,
                command,
                token: deployToken,
                expiresAt
            });
        } catch (err) {
            console.error('[Admin AutoConfig POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },

    GET: async (req, reply) => {
        try {
            const token = req.query.token;
            if (!token) return reply.status(400).send({ error: 'Configuration token missing.' });
            if (checkRateLimit(reply, token, 'ADMIN_AUTOCONFIG_FETCH', 20, 60000)) return;

            const db = getDB();
            const tokenDoc = await db.collection('node_tokens').findOne({ token, used: false });

            if (!tokenDoc) {
                return reply.status(403).send({ error: 'Invalid or already used deploy token.' });
            }

            if (new Date(tokenDoc.expiresAt) < new Date()) {
                return reply.status(403).send({ error: 'Deploy token has expired.' });
            }

            const node = await db.collection('nodes').findOne({ id: tokenDoc.nodeId });
            if (!node) return reply.status(404).send({ error: 'Associated node not found.' });

            await db.collection('node_tokens').updateOne({ token }, { $set: { used: true } });

            const wingsConfig = {
                debug: false,
                uuid: node.id,
                token_id: node.id.replace('node_', ''),
                token: node.daemonKey,
                api: {
                    host: '0.0.0.0',
                    port: node.daemonPort || 8080,
                    ssl: {
                        enabled: true,
                        cert: `/etc/letsencrypt/live/${node.fqdn}/fullchain.pem`,
                        key: `/etc/letsencrypt/live/${node.fqdn}/privkey.pem`
                    },
                    upload_limit: node.uploadSize || 100
                },
                system: {
                    data: '/var/lib/cyruspanel/volumes'
                },
                allowed_mounts: []
            };

            return reply.status(200).send(wingsConfig);
        } catch (err) {
            console.error('[Admin AutoConfig GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};