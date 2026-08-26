const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
const { logActivity } = require('../../../../../../lib/logActivity');

const ONE_HOUR_MS = 60 * 60 * 1000;

function extractServerId(req) {
  return (
    req.params?.id ||
    req.params?.serverId ||
    req.query?.serverId ||
    req.query?.id ||
    req.body?.serverId
  );
}

module.exports = {
  GET: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SETTINGS_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('settings.view')) {
        return reply.status(403).send({ error: 'Access denied: Requires settings.view permission.' });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });

      const installTime = server.installationStartedTimestamp ? Number(server.installationStartedTimestamp) : (server.createdAt ? new Date(server.createdAt).getTime() : 0);
      const isInstallTimedOut = Boolean(server.installing && installTime && (Date.now() - installTime > ONE_HOUR_MS));
      const effectiveInstalling = Boolean(server.installing && !isInstallTimedOut);
      const liveStatus = isInstallTimedOut ? 'installation_failed' : (effectiveInstalling ? 'installing' : (server.status || 'offline'));

      return reply.status(200).send({
        id: server.id,
        name: server.name,
        description: server.description || '',
        nodeName: node ? node.name : 'Unknown Node',
        installing: effectiveInstalling,
        suspended: Boolean(server.suspended),
        status: liveStatus,
        createdAt: server.createdAt,
        isOwner,
        canChangeInfo: isOwner || permissions.includes('settings.change.info'),
        canReinstall: isOwner || permissions.includes('settings.reinstall')
      });
    } catch (err) {
      console.error('[Client Settings GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while fetching server settings.' });
    }
  },

  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SETTINGS_POST', 20, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);

      const installTime = server.installationStartedTimestamp ? Number(server.installationStartedTimestamp) : (server.createdAt ? new Date(server.createdAt).getTime() : 0);
      const isInstallTimedOut = Boolean(server.installing && installTime && (Date.now() - installTime > ONE_HOUR_MS));
      const effectiveInstalling = Boolean(server.installing && !isInstallTimedOut);

      const { action, name, description } = req.body || {};
      if (action === 'rename' || (!action && (name !== undefined || description !== undefined))) {
        if (!isOwner && !permissions.includes('settings.change.info')) {
          return reply.status(403).send({ error: 'Access denied: Requires settings.change.info permission.' });
        }

        if (server.suspended) {
          return reply.status(403).send({ error: 'Server details cannot be modified while server is suspended.' });
        }

        if (effectiveInstalling) {
          return reply.status(400).send({ error: 'Server details cannot be modified while server is installing.' });
        }

        const updateDoc = {};

        if (name !== undefined) {
          const cleanName = String(name || '').trim();
          if (cleanName.length < 1 || cleanName.length > 64) {
            return reply.status(400).send({ error: 'Server name must be between 1 and 64 characters.' });
          }
          if (!/^[a-zA-Z0-9_\-\.\s]+$/.test(cleanName)) {
            return reply.status(400).send({
              error: 'Server name may only contain letters, numbers, spaces, underscores, periods, and dashes.'
            });
          }
          updateDoc.name = cleanName;
        }

        if (description !== undefined) {
          const cleanDesc = String(description || '').trim();
          if (cleanDesc.length > 255) {
            return reply.status(400).send({ error: 'Description cannot exceed 255 characters.' });
          }
          updateDoc.description = cleanDesc;
        }

        if (Object.keys(updateDoc).length === 0) {
          return reply.status(400).send({ error: 'No fields provided to update.' });
        }

        await db.collection('servers').updateOne({ id: server.id }, { $set: updateDoc });

        if (updateDoc.name) {
          await db.collection('allocations').updateMany(
            { assignedServerId: server.id },
            { $set: { assignedServerName: updateDoc.name } }
          );
        }

        const changeDetails = [];
        if (updateDoc.name) changeDetails.push(`name to "${updateDoc.name}"`);
        if (updateDoc.description !== undefined) changeDetails.push(`description`);

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:settings.rename',
          detail: `Modified server ${changeDetails.join(' and ')}`,
          metadata: updateDoc
        });

        return reply.status(200).send({
          success: true,
          message: 'Server details updated successfully.',
          server: { ...server, ...updateDoc }
        });
      }
      if (action === 'reinstall') {
        if (!isOwner && !permissions.includes('settings.reinstall')) {
          return reply.status(403).send({ error: 'Access denied: Requires settings.reinstall permission.' });
        }

        if (server.suspended) {
          return reply.status(403).send({ error: 'Suspended servers cannot be reinstalled. Please renew the server first.' });
        }

        if (effectiveInstalling) {
          return reply.status(400).send({ error: 'Server is already undergoing an installation process.' });
        }

        const node = await db.collection('nodes').findOne({ id: server.nodeId });
        if (!node) return reply.status(404).send({ error: 'Node daemon not found.' });

        const egg = await db.collection('eggs').findOne({ id: server.eggId });
        if (!egg) return reply.status(404).send({ error: 'Egg template configuration not found.' });

        const primaryAlloc = await db.collection('allocations').findOne({ id: server.allocationId });

        const reinstallPayload = {
          id: server.id,
          name: server.name,
          dockerImage: server.dockerImage,
          startup: server.startup || egg.startup || '',
          env: server.env || {},
          memory: server.memory,
          disk: server.disk,
          cpu: server.cpu,
          eggScript: egg.scripts || {},
          allocations: {
            primary: primaryAlloc ? { ip: primaryAlloc.ip, port: primaryAlloc.port } : { ip: '0.0.0.0', port: 25565 },
            additional: []
          }
        };

        const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
        const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        const port = node.daemonPort || 8080;

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          const daemonRes = await fetch(`${scheme}://${rawFqdn}:${port}/api/servers/${server.id}/reinstall`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${node.daemonKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(reinstallPayload),
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (!daemonRes.ok) {
            const dData = await daemonRes.json().catch(() => ({}));
            return reply.status(400).send({ error: dData.error || 'Could not reach the daemon.' });
          }
        } catch {
          return reply.status(502).send({ error: 'Failed to communicate with node daemon. Server reinstallation aborted.' });
        }

        await db.collection('servers').updateOne(
          { id: server.id },
          {
            $set: {
              installing: true,
              installationStartedTimestamp: Date.now(),
              status: 'installing'
            }
          }
        );

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:settings.reinstall',
          detail: `Triggered container reinstallation and egg provisioner for ${server.name}`
        });

        return reply.status(200).send({
          success: true,
          message: 'Server reinstallation initiated. Please wait while the environment is prepared.'
        });
      }
      if (action === 'delete') {
        if (!isOwner) {
          return reply.status(403).send({ error: 'Access denied: Only the server owner can delete this server.' });
        }

        if (effectiveInstalling && server.status !== 'installation_failed') {
          return reply.status(400).send({ error: 'Cannot delete server while it is actively installing.' });
        }

        const node = await db.collection('nodes').findOne({ id: server.nodeId });
        if (node) {
          const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
          const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const port = node.daemonPort || 8080;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);

            await fetch(`${scheme}://${rawFqdn}:${port}/api/servers/${server.id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${node.daemonKey}` },
              signal: controller.signal
            });
            clearTimeout(timeoutId);
          } catch {
            await db.collection('pending_deletions').insertOne({
              nodeId: node.id,
              uuid: server.id,
              queuedAt: new Date().toISOString()
            });
          }
        }

        const allAllocIds = [server.allocationId, ...(server.additionalAllocationIds || [])].filter(Boolean);
        if (allAllocIds.length > 0) {
          await db.collection('allocations').updateMany(
            { id: { $in: allAllocIds } },
            { $set: { assignedServerId: null, assignedServerName: null, notes: '' } }
          );
        }

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:settings.delete',
          detail: `Permanently deleted server instance ${server.name} (${server.id})`
        });
        await db.collection('server_subusers').deleteMany({ serverId: server.id });
        await db.collection('servers').deleteOne({ id: server.id });

        return reply.status(200).send({
          success: true,
          message: 'Server has been successfully deleted.'
        });
      }

      return reply.status(400).send({ error: 'Invalid action provided.' });
    } catch (err) {
      console.error('[Client Settings POST Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while processing server settings.' });
    }
  }
};
