const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
const { logActivity } = require('../../../../../../lib/logActivity');

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

      if (checkRateLimit(reply, req.userId, 'CLIENT_NETWORK_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('network.view')) {
        return reply.status(403).send({ error: 'Access denied: Requires network.view permission.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'Network configuration is unavailable while the server is suspended.' });
      }

      const primaryId = server.allocationId;
      const additionalIds = Array.isArray(server.additionalAllocationIds) ? server.additionalAllocationIds : [];
      const allServerAllocIds = [primaryId, ...additionalIds].filter(Boolean);

      const serverAllocations = await db.collection('allocations')
        .find({ id: { $in: allServerAllocIds } })
        .toArray();

      const availableOnNode = await db.collection('allocations').countDocuments({
        nodeId: server.nodeId,
        assignedServerId: null
      });

      const formattedAllocations = serverAllocations.map((alloc) => ({
        id: alloc.id,
        ip: alloc.ip,
        port: alloc.port,
        alias: alloc.alias || null,
        isPrimary: alloc.id === primaryId,
        notes: alloc.notes || ''
      }));

      formattedAllocations.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || a.port - b.port);

      const maxAllocations = Math.min(50, Math.max(1, parseInt(server.maxAllocations, 10) || 5));

      return reply.status(200).send({
        allocations: formattedAllocations,
        maxAllocations,
        availableOnNode,
        assignedCount: formattedAllocations.length,
        canManage: isOwner || permissions.includes('network.manage')
      });
    } catch (err) {
      console.error('[Client Network GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while fetching network details.' });
    }
  },

  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_NETWORK_POST', 30, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('network.manage')) {
        return reply.status(403).send({ error: 'Access denied: Requires network.manage permission.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'Network configuration cannot be modified while server is suspended.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'Network configuration cannot be modified while server is installing.' });
      }

      const { action, allocationId, notes } = req.body || {};
      const primaryId = server.allocationId;
      const additionalIds = Array.isArray(server.additionalAllocationIds) ? server.additionalAllocationIds : [];
      const maxAllocations = Math.min(50, Math.max(1, parseInt(server.maxAllocations, 10) || 5));
      const currentTotal = 1 + additionalIds.length;
      if (action === 'assign') {
        if (currentTotal >= maxAllocations) {
          return reply.status(400).send({ error: `Server has reached its maximum limit of ${maxAllocations} allocations.` });
        }

        const availableAlloc = await db.collection('allocations').findOne({
          nodeId: server.nodeId,
          assignedServerId: null
        });

        if (!availableAlloc) {
          return reply.status(400).send({ error: 'No available unassigned ports found on this node.' });
        }

        await db.collection('allocations').updateOne(
          { id: availableAlloc.id },
          {
            $set: {
              assignedServerId: server.id,
              assignedServerName: server.name,
              notes: ''
            }
          }
        );

        await db.collection('servers').updateOne(
          { id: server.id },
          { $addToSet: { additionalAllocationIds: availableAlloc.id } }
        );

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:network.assign',
          detail: `Allocated new port ${availableAlloc.ip}:${availableAlloc.port}`,
          metadata: { allocationId: availableAlloc.id, ip: availableAlloc.ip, port: availableAlloc.port }
        });

        return reply.status(200).send({
          success: true,
          message: 'New port successfully allocated to server.'
        });
      }
      if (action === 'set-primary') {
        if (!allocationId) return reply.status(400).send({ error: 'Target allocation ID is required.' });
        if (allocationId === primaryId) {
          return reply.status(400).send({ error: 'This port is already the primary allocation.' });
        }

        if (!additionalIds.includes(allocationId)) {
          return reply.status(400).send({ error: 'Selected allocation does not belong to this server.' });
        }

        const targetAlloc = await db.collection('allocations').findOne({ id: allocationId });

        const newAdditionals = additionalIds.filter((id) => id !== allocationId);
        newAdditionals.push(primaryId);

        await db.collection('servers').updateOne(
          { id: server.id },
          {
            $set: {
              allocationId: allocationId,
              additionalAllocationIds: newAdditionals
            }
          }
        );

        const epStr = targetAlloc ? `${targetAlloc.ip}:${targetAlloc.port}` : allocationId;
        logActivity(req, db, {
          serverId: server.id,
          action: 'server:network.primary',
          detail: `Set primary connection port to ${epStr}`,
          metadata: { allocationId }
        });

        return reply.status(200).send({
          success: true,
          message: 'Primary allocation updated successfully.'
        });
      }
      if (action === 'delete') {
        if (!allocationId) return reply.status(400).send({ error: 'Allocation ID is required.' });

        if (allocationId === primaryId) {
          return reply.status(400).send({ error: 'Cannot delete the primary connection allocation.' });
        }

        if (!additionalIds.includes(allocationId)) {
          return reply.status(400).send({ error: 'Allocation does not belong to this server.' });
        }

        const targetAlloc = await db.collection('allocations').findOne({ id: allocationId });

        await db.collection('allocations').updateOne(
          { id: allocationId },
          {
            $set: {
              assignedServerId: null,
              assignedServerName: null,
              notes: ''
            }
          }
        );

        await db.collection('servers').updateOne(
          { id: server.id },
          { $pull: { additionalAllocationIds: allocationId } }
        );

        const epStr = targetAlloc ? `${targetAlloc.ip}:${targetAlloc.port}` : allocationId;
        logActivity(req, db, {
          serverId: server.id,
          action: 'server:network.delete',
          detail: `Unassigned and returned allocation ${epStr} to node pool`,
          metadata: { allocationId }
        });

        return reply.status(200).send({
          success: true,
          message: 'Allocation unassigned and released back to node pool.'
        });
      }
      if (action === 'notes') {
        if (!allocationId) return reply.status(400).send({ error: 'Allocation ID is required.' });

        const allIds = [primaryId, ...additionalIds];
        if (!allIds.includes(allocationId)) {
          return reply.status(400).send({ error: 'Allocation does not belong to this server.' });
        }

        const targetAlloc = await db.collection('allocations').findOne({ id: allocationId });
        const cleanNotes = typeof notes === 'string' ? notes.slice(0, 100).trim() : '';

        await db.collection('allocations').updateOne(
          { id: allocationId },
          { $set: { notes: cleanNotes } }
        );

        const epStr = targetAlloc ? `${targetAlloc.ip}:${targetAlloc.port}` : allocationId;
        logActivity(req, db, {
          serverId: server.id,
          action: 'server:network.notes',
          detail: `Updated note for ${epStr} to "${cleanNotes || 'empty'}"`,
          metadata: { allocationId, notes: cleanNotes }
        });

        return reply.status(200).send({
          success: true,
          message: 'Notes updated.'
        });
      }

      return reply.status(400).send({ error: 'Invalid action provided.' });
    } catch (err) {
      console.error('[Client Network POST Error]:', err);
      return reply.status(500).send({ error: 'Failed to process network operation.' });
    }
  }
};