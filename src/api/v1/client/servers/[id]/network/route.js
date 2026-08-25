const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
const { logActivity } = require('../../../../../../lib/logActivity');

function extractServerId(req) {
  const rawId =
    req.params?.id ||
    req.params?.serverId ||
    req.query?.serverId ||
    req.query?.id ||
    req.body?.serverId;

  return typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
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
      const maxAllocations = Math.min(50, Math.max(1, parseInt(server.maxAllocations, 10) || 5));

      if (action === 'assign') {
        const assignedAlloc = await db.collection('allocations').findOneAndUpdate(
          {
            nodeId: server.nodeId,
            assignedServerId: null
          },
          {
            $set: {
              assignedServerId: server.id,
              assignedServerName: server.name || '',
              notes: ''
            }
          },
          { returnDocument: 'after' }
        );

        if (!assignedAlloc) {
          return reply.status(400).send({ error: 'No available unassigned ports found on this node.' });
        }

        const serverUpdateResult = await db.collection('servers').updateOne(
          {
            id: server.id,
            $expr: {
              $lt: [
                { $add: [1, { $size: { $ifNull: ['$additionalAllocationIds', []] } }] },
                maxAllocations
              ]
            }
          },
          { $addToSet: { additionalAllocationIds: assignedAlloc.id } }
        );

        if (serverUpdateResult.modifiedCount !== 1) {
          await db.collection('allocations').updateOne(
            { id: assignedAlloc.id, assignedServerId: server.id },
            {
              $set: {
                assignedServerId: null,
                assignedServerName: null,
                notes: ''
              }
            }
          );

          return reply.status(400).send({
            error: `Server has reached its maximum limit of ${maxAllocations} allocations.`
          });
        }

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:network.assign',
          detail: `Allocated new port ${assignedAlloc.ip}:${assignedAlloc.port}`,
          metadata: { allocationId: assignedAlloc.id, ip: assignedAlloc.ip, port: assignedAlloc.port }
        });

        return reply.status(200).send({
          success: true,
          message: 'New port successfully allocated to server.'
        });
      }

      if (action === 'set-primary') {
        if (!allocationId || typeof allocationId !== 'string') {
          return reply.status(400).send({ error: 'Target allocation ID is required.' });
        }

        if (allocationId === primaryId) {
          return reply.status(400).send({ error: 'This port is already the primary allocation.' });
        }

        const freshServer = await db.collection('servers').findOne({ id: server.id });
        const currentPrimary = freshServer?.allocationId;
        const currentAdditionals = Array.isArray(freshServer?.additionalAllocationIds)
          ? freshServer.additionalAllocationIds
          : [];

        if (!currentAdditionals.includes(allocationId)) {
          return reply.status(400).send({ error: 'Selected allocation does not belong to this server.' });
        }

        const newAdditionals = currentAdditionals.filter((id) => id !== allocationId);
        if (currentPrimary && !newAdditionals.includes(currentPrimary)) {
          newAdditionals.push(currentPrimary);
        }

        const swapResult = await db.collection('servers').updateOne(
          {
            id: server.id,
            allocationId: currentPrimary,
            additionalAllocationIds: allocationId
          },
          {
            $set: {
              allocationId: allocationId,
              additionalAllocationIds: newAdditionals
            }
          }
        );

        if (swapResult.modifiedCount !== 1) {
          return reply.status(409).send({ error: 'Concurrent update detected. Please try again.' });
        }

        const targetAlloc = await db.collection('allocations').findOne({ id: allocationId });
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
        if (!allocationId || typeof allocationId !== 'string') {
          return reply.status(400).send({ error: 'Allocation ID is required.' });
        }

        if (allocationId === primaryId) {
          return reply.status(400).send({ error: 'Cannot delete the primary connection allocation.' });
        }

        const serverUpdate = await db.collection('servers').updateOne(
          { id: server.id, additionalAllocationIds: allocationId },
          { $pull: { additionalAllocationIds: allocationId } }
        );

        if (serverUpdate.modifiedCount !== 1) {
          return reply.status(400).send({ error: 'Allocation does not belong to this server.' });
        }

        const freedAlloc = await db.collection('allocations').findOneAndUpdate(
          { id: allocationId, assignedServerId: server.id },
          {
            $set: {
              assignedServerId: null,
              assignedServerName: null,
              notes: ''
            }
          },
          { returnDocument: 'before' }
        );

        const epStr = freedAlloc ? `${freedAlloc.ip}:${freedAlloc.port}` : allocationId;

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
        if (!allocationId || typeof allocationId !== 'string') {
          return reply.status(400).send({ error: 'Allocation ID is required.' });
        }

        const cleanNotes = typeof notes === 'string' ? notes.slice(0, 100).trim() : '';

        const updateResult = await db.collection('allocations').updateOne(
          { id: allocationId, assignedServerId: server.id },
          { $set: { notes: cleanNotes } }
        );

        if (updateResult.matchedCount !== 1) {
          return reply.status(400).send({ error: 'Allocation does not belong to this server.' });
        }

        const targetAlloc = await db.collection('allocations').findOne({ id: allocationId });
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
