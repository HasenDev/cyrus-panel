const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { checkRateLimit } = require('../../../../lib/rateLimit');

module.exports = {
  GET: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVERS_GET', 60, 60000)) return;

      const db = getDB();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const skip = (page - 1) * limit;
      const subUserDocs = await db.collection('server_subusers').find({ userId: req.userId }).toArray();
      const sharedServerIds = subUserDocs.map(d => d.serverId);

      const query = {
        $or: [
          { ownerId: req.userId },
          { id: { $in: sharedServerIds } }
        ]
      };

      const totalCount = await db.collection('servers').countDocuments(query);
      const servers = await db.collection('servers')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const nodeIds = [...new Set(servers.map(s => s.nodeId).filter(Boolean))];
      const nestIds = [...new Set(servers.map(s => s.nestId).filter(Boolean))];
      const eggIds = [...new Set(servers.map(s => s.eggId).filter(Boolean))];
      const allocIds = [...new Set(servers.map(s => s.allocationId).filter(Boolean))];

      const [nodes, nests, eggs, allocations] = await Promise.all([
        db.collection('nodes').find({ id: { $in: nodeIds } }).toArray(),
        db.collection('nests').find({ id: { $in: nestIds } }).toArray(),
        db.collection('eggs').find({ id: { $in: eggIds } }).toArray(),
        db.collection('allocations').find({ id: { $in: allocIds } }).toArray()
      ]);

      const processedServers = await Promise.all(servers.map(async (server) => {
        const node = nodes.find(n => n.id === server.nodeId);
        const nest = nests.find(n => n.id === server.nestId);
        const egg = eggs.find(e => e.id === server.eggId);
        const alloc = allocations.find(a => a.id === server.allocationId);
        const isShared = server.ownerId !== req.userId;
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

        return {
          id: server.id,
          name: server.name,
          description: server.description || '',
          status: liveStatus,
          installing: Boolean(server.installing),
          suspended: isSuspended,
          shared: isShared,
          ipAddress: alloc ? alloc.ip : '0.0.0.0',
          port: alloc ? alloc.port : 25565,
          memory: server.memory || 1024,
          disk: server.disk || 5000,
          cpu: server.cpu || 100,
          nodeName: node ? node.name : 'Unknown Node',
          nestName: nest ? nest.name : 'Custom',
          eggName: egg ? egg.name : 'Generic Container',
          createdAt: server.createdAt
        };
      }));

      return reply.status(200).send({
        success: true,
        totalCount,
        page,
        totalPages: Math.ceil(totalCount / limit) || 1,
        servers: processedServers
      });
    } catch (err) {
      console.error('[Client Servers GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  },

  DELETE: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVERS_DELETE', 15, 60000)) return;

      const db = getDB();
      const { id } = req.body || {};
      if (!id) return reply.status(400).send({ error: 'Server ID is required.' });
      const server = await db.collection('servers').findOne({ id, ownerId: req.userId });
      if (!server) {
        return reply.status(404).send({ error: 'Server not found or access denied.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'Cannot delete a server while installation is in progress.' });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });
      let daemonNotified = false;

      if (node) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3500);
          const daemonRes = await fetch(`https://${node.fqdn}:${node.daemonPort || 8080}/api/servers/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${node.daemonKey}` },
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (daemonRes.ok) daemonNotified = true;
        } catch {}
      }

      if (!daemonNotified && node) {
        await db.collection('pending_deletions').updateOne(
          { uuid: server.id },
          { $set: { uuid: server.id, nodeId: node.id, createdAt: new Date() } },
          { upsert: true }
        );
      }
      await db.collection('allocations').updateMany(
        { assignedServerId: id },
        { $set: { assignedServerId: null, assignedServerName: null, notes: '' } }
      );
      await db.collection('server_subusers').deleteMany({ serverId: id });
      await db.collection('servers').deleteOne({ id });
      return reply.status(200).send({
        success: true,
        message: 'Server deleted successfully.'
      });
    } catch (err) {
      console.error('[Client Server DELETE Error]:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  }
};