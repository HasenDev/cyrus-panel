const { getDB } = require('../../../../../lib/db');
const { authenticate } = require('../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../lib/serverPermissions');

const ONE_HOUR_MS = 60 * 60 * 1000;

module.exports = {
  GET: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;
      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_MANAGE_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = req.query.serverId || req.query.id;
      if (!serverId || typeof serverId !== 'string') {
        return reply.status(400).send({ error: 'Server ID is required.' });
      }

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) {
        return reply.status(404).send({ error: 'Server not found or access denied.' });
      }

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && permissions.length === 0) {
        return reply.status(403).send({ error: 'Access denied to this server instance.' });
      }

      const [node, nest, egg, allocations] = await Promise.all([
        db.collection('nodes').findOne({ id: server.nodeId }),
        db.collection('nests').findOne({ id: server.nestId }),
        db.collection('eggs').findOne({ id: server.eggId }),
        db.collection('allocations').find({ nodeId: server.nodeId }).toArray()
      ]);

      const primaryAlloc = allocations.find(a => a.id === server.allocationId);
      const allocStr = primaryAlloc ? `${primaryAlloc.ip}:${primaryAlloc.port}` : '0.0.0.0:25565';

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
        : (server.suspended ? 'suspended' : (server.status || 'offline'));

      if (!effectiveInstalling && !isInstallTimedOut && !server.suspended && node && !node.maintenanceMode) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          const daemonRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${server.id}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${node.daemonKey}` },
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (daemonRes.ok) {
            const statusData = await daemonRes.json();
            liveStatus = statusData.status || liveStatus;
          } else {
            liveStatus = 'offline';
          }
        } catch {
          liveStatus = 'offline_node';
        }
      } else if (node && node.maintenanceMode) {
        liveStatus = 'maintenance';
      } else if (!node) {
        liveStatus = 'offline_node';
      }

      const assignedAllocations = allocations.filter(a =>
        a.id === server.allocationId ||
        (Array.isArray(server.additionalAllocationIds) && server.additionalAllocationIds.includes(a.id))
      );

      return reply.status(200).send({
        success: true,
        isOwner,
        userPermissions: permissions,
        server: {
          id: server.id || server._id.toString(),
          name: server.name,
          description: server.description || '',
          ownerId: server.ownerId,
          ownerUsername: server.ownerUsername || 'User',
          nodeId: server.nodeId,
          allocationId: server.allocationId,
          additionalAllocationIds: server.additionalAllocationIds || [],
          nestId: server.nestId,
          eggId: server.eggId,
          packageId: server.packageId || null,
          packageName: server.packageName || 'Standard Package',
          planId: server.planId || null,
          planName: server.planName || 'Standard Tier',
          dockerImage: server.dockerImage || 'ubuntu:latest',
          startup: server.startup || '',
          memory: server.memory || 1024,
          disk: server.disk || 5000,
          cpu: server.cpu || 100,
          priceCredits: server.priceCredits || 0,
          maxAllocations: Math.min(50, Math.max(0, parseInt(server.maxAllocations, 10) || 0)),
          installing: effectiveInstalling,
          suspended: Boolean(server.suspended),
          status: liveStatus,
          allocation: allocStr,
          createdAt: server.createdAt
        },
        nodeName: node ? node.name : 'Unknown Node',
        nestName: nest ? nest.name : 'Unknown Nest',
        eggName: egg ? egg.name : 'Unknown Egg',
        allocations: assignedAllocations.map(a => ({
          id: a.id || a._id.toString(),
          ip: a.ip,
          port: a.port,
          assignedServerId: a.assignedServerId || null
        }))
      });
    } catch (err) {
      console.error('[Client Manage Server GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  }
};
