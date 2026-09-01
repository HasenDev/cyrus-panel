const { getDB } = require('../../../../../lib/db');
const { authenticate } = require('../../../../../lib/auth');
const { getPermissions } = require('../../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../../lib/rateLimit');

const ONE_HOUR_MS = 60 * 60 * 1000;

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SERVER_MANAGE_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SERVERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SERVERS permission.' });
            }

            const serverId = req.query.serverId || req.query.id;
            if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

            const server = await db.collection('servers').findOne({ id: serverId });
            if (!server) return reply.status(404).send({ error: 'Server not found.' });

            const node = await db.collection('nodes').findOne({ id: server.nodeId });
            const nest = await db.collection('nests').findOne({ id: server.nestId });
            const egg = await db.collection('eggs').findOne({ id: server.eggId });
            const allocations = await db.collection('allocations').find({ nodeId: server.nodeId }).toArray();

            const isInstallTimedOut = Boolean(
                server.installing &&
                server.installationStartedTimestamp &&
                (Date.now() - Number(server.installationStartedTimestamp) > ONE_HOUR_MS)
            );
            const effectiveInstalling = Boolean(server.installing && !isInstallTimedOut);

            let liveStatus = isInstallTimedOut
                ? 'installation_failed'
                : effectiveInstalling
                ? 'installing'
                : (server.status || 'offline');

            if (!effectiveInstalling && !isInstallTimedOut && node) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2000);
                    const daemonRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${server.id}`, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${node.daemonKey}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (daemonRes.ok) {
                        const statusData = await daemonRes.json();
                        liveStatus = statusData.status || liveStatus;
                    }
                } catch {
                    liveStatus = 'offline';
                }
            }

            return reply.status(200).send({
                server: {
                    ...server,
                    installing: effectiveInstalling,
                    maxAllocations: Math.min(50, Math.max(0, parseInt(server.maxAllocations, 10) || 0)),
                    status: liveStatus
                },
                nodeName: node ? node.name : 'Unknown Node',
                nestName: nest ? nest.name : 'Unknown Nest',
                eggName: egg ? egg.name : 'Unknown Egg',
                eggDockerImages: egg ? egg.docker_images : {},
                eggVariables: egg ? egg.variables : [],
                allocations
            });
        } catch (err) {
            console.error('[Admin Manage Server GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SERVER_MANAGE_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SERVERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SERVERS permission.' });
            }

            const {
                id,
                name,
                description,
                ownerId,
                allocationId,
                additionalAllocationIds,
                dockerImage,
                startup,
                environment,
                memory,
                disk,
                cpu,
                priceCredits,
                maxAllocations
            } = req.body || {};

            if (!id) return reply.status(400).send({ error: 'Server ID is required.' });

            const existingServer = await db.collection('servers').findOne({ id });
            if (!existingServer) return reply.status(404).send({ error: 'Server not found.' });

            const isInstallTimedOut = Boolean(
                existingServer.installing &&
                existingServer.installationStartedTimestamp &&
                (Date.now() - Number(existingServer.installationStartedTimestamp) > ONE_HOUR_MS)
            );

            if (existingServer.installing && !isInstallTimedOut) {
                return reply.status(400).send({ error: 'Configuration cannot be updated while server is installing.' });
            }

            const node = await db.collection('nodes').findOne({ id: existingServer.nodeId });
            if (!node) return reply.status(404).send({ error: 'Associated node daemon not found.' });

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2500);
                const pingRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/test`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${node.daemonKey}` },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!pingRes.ok) {
                    return reply.status(502).send({ error: 'Node daemon is currently offline. Configuration changes were not saved.' });
                }
            } catch {
                return reply.status(502).send({ error: 'Node daemon is currently offline. Configuration changes were not saved.' });
            }

            const updates = {};

            if (typeof name === 'string' && name.trim()) updates.name = name.trim();
            if (typeof description === 'string') updates.description = description.trim();
            if (typeof dockerImage === 'string') updates.dockerImage = dockerImage.trim();
            if (typeof startup === 'string') updates.startup = startup.trim();

            if (memory !== undefined) updates.memory = Math.max(128, parseInt(memory, 10) || 1024);
            if (disk !== undefined) updates.disk = Math.max(512, parseInt(disk, 10) || 5000);
            if (cpu !== undefined) updates.cpu = Math.max(10, parseInt(cpu, 10) || 100);
            if (priceCredits !== undefined) updates.priceCredits = Math.max(0, parseInt(priceCredits, 10) || 0);
            if (maxAllocations !== undefined) updates.maxAllocations = Math.min(50, Math.max(0, parseInt(maxAllocations, 10) || 0));

            if (ownerId && ownerId !== existingServer.ownerId) {
                const owner = await db.collection('users').findOne({ _id: ownerId });
                if (!owner) return reply.status(404).send({ error: 'New owner user not found.' });
                updates.ownerId = owner._id;
                updates.ownerUsername = owner.username;
            }

            if (environment && typeof environment === 'object') {
                updates.env = { ...existingServer.env, ...environment };
            }

            if (allocationId || Array.isArray(additionalAllocationIds)) {
                const newPrimary = allocationId || existingServer.allocationId;
                const newAdditionals = Array.isArray(additionalAllocationIds)
                    ? additionalAllocationIds
                    : (existingServer.additionalAllocationIds || []);

                const oldAllocs = [existingServer.allocationId, ...(existingServer.additionalAllocationIds || [])];
                await db.collection('allocations').updateMany(
                    { id: { $in: oldAllocs } },
                    { $set: { assignedServerId: null, assignedServerName: null } }
                );

                const newAllocs = [newPrimary, ...newAdditionals];
                await db.collection('allocations').updateMany(
                    { id: { $in: newAllocs } },
                    { $set: { assignedServerId: existingServer.id, assignedServerName: updates.name || existingServer.name } }
                );

                updates.allocationId = newPrimary;
                updates.additionalAllocationIds = newAdditionals;
            }

            await db.collection('servers').updateOne({ id }, { $set: updates });

            return reply.status(200).send({
                success: true,
                message: 'Done! This will require a restart to apply changes.'
            });
        } catch (err) {
            console.error('[Admin Manage Server PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_SERVER_MANAGE_DELETE', 10, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_SERVERS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_SERVERS permission.' });
            }

            const { id, force } = req.body || {};
            if (!id) return reply.status(400).send({ error: 'Server ID is required.' });

            const server = await db.collection('servers').findOne({ id });
            if (!server) return reply.status(404).send({ error: 'Server not found.' });

            const node = await db.collection('nodes').findOne({ id: server.nodeId });

            if (!force && node) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 4000);
                    const daemonRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${node.daemonKey}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (!daemonRes.ok) {
                        const daemonErr = await daemonRes.json().catch(() => ({}));
                        return reply.status(400).send({
                            error: `Daemon Deletion Failed: ${daemonErr.error || 'Node refused to delete container.'}`
                        });
                    }
                } catch {
                    return reply.status(502).send({
                        error: `Node Daemon Unreachable. Use Force Delete to purge server from database.`
                    });
                }
            } else if (force && node) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2000);
                    await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${node.daemonKey}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                } catch {}
            }

            await db.collection('allocations').updateMany(
                { assignedServerId: id },
                { $set: { assignedServerId: null, assignedServerName: null } }
            );

            await db.collection('servers').deleteOne({ id });

            return reply.status(200).send({
                success: true,
                message: force ? 'Server forcibly purged from database.' : 'Server deleted successfully.'
            });
        } catch (err) {
            console.error('[Admin Manage Server DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) return reply.status(401).send({ error: 'Authorization header required.' });
            let daemonKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
            if (checkRateLimit(reply, daemonKey, 'DAEMON_INSTALL_CALLBACK', 30, 60000)) return;
            const db = getDB();
            const node = await db.collection('nodes').findOne({ daemonKey });
            if (!node) return reply.status(401).send({ error: 'Invalid daemon key.' });

            const { serverId, status } = req.body || {};
            if (!serverId) return reply.status(400).send({ error: 'serverId is required.' });

            const isSuccess = status === 'completed' || status === 'success';

            await db.collection('servers').updateOne(
                { id: serverId, nodeId: node.id },
                {
                    $set: {
                        installing: false,
                        status: isSuccess ? 'offline' : 'installation_failed'
                    },
                    $unset: {
                        installationStartedTimestamp: ''
                    }
                }
            );

            return reply.status(200).send({ success: true, message: 'Installation state updated.' });
        } catch (err) {
            console.error('[Daemon Install Callback Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};
