const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const {
  getUserServerPermissions,
  normalizePermissions,
  ALL_PERMISSIONS
} = require('../../../../../../lib/serverPermissions');
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
async function revokeDaemonUserWs(node, userId, serverId) {
  if (!node || !userId) return;
  try {
    const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
    const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const port = node.daemonPort || 8080;
    const targetUrl = `${scheme}://${rawFqdn}:${port}/api/user/revoke-ws`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${node.daemonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId, serverId }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    console.warn(`[Subuser WS Revoke] Failed to notify daemon on node ${node?.id}:`, err?.message || err);
  }
}
function applyPermissionDependencies(perms = []) {
  const permSet = new Set(perms);
  if (permSet.has('files.editfile')) {
    permSet.add('files.content');
  }
  return normalizePermissions(Array.from(permSet));
}

module.exports = {
  GET: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_USERS_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('users.view')) {
        return reply.status(403).send({ error: 'Access denied: Requires users.view permission.' });
      }

      const [ownerUser, subUsers] = await Promise.all([
        db.collection('users').findOne({ _id: server.ownerId }),
        db.collection('server_subusers').find({ serverId }).toArray()
      ]);

      const subUserIds = subUsers.map((s) => s.userId);
      const userDocs = await db.collection('users').find({ _id: { $in: subUserIds } }).toArray();
      const userMap = new Map(userDocs.map((u) => [u._id, u]));

      const formattedSubUsers = subUsers.map((s) => {
        const u = userMap.get(s.userId);
        return {
          id: s.userId,
          email: u ? u.email : s.userEmail,
          username: u ? u.username : 'Unknown User',
          avatarUrl: u ? u.avatarUrl : null,
          permissions: s.permissions || [],
          createdAt: s.createdAt || Date.now(),
          isOwner: false
        };
      });

      const formattedOwner = {
        id: server.ownerId,
        email: ownerUser ? ownerUser.email : 'owner@domain.com',
        username: ownerUser ? ownerUser.username : (server.ownerUsername || 'Owner'),
        avatarUrl: ownerUser ? ownerUser.avatarUrl : null,
        permissions: ALL_PERMISSIONS,
        createdAt: server.createdAt,
        isOwner: true
      };

      return reply.status(200).send({
        success: true,
        users: [formattedOwner, ...formattedSubUsers],
        currentUserPermissions: permissions,
        isOwner
      });
    } catch (err) {
      console.error('[Server Users GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error.' });
    }
  },
  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_USERS_POST', 20, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      const { email, permissions } = req.body || {};

      if (!serverId || !email) {
        return reply.status(400).send({ error: 'Server ID and user email are required.' });
      }

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      const actorPerms = await getUserServerPermissions(req.userId, server, db);
      if (!actorPerms.isOwner && !actorPerms.permissions.includes('users.add')) {
        return reply.status(403).send({ error: 'Access denied: Requires users.add permission.' });
      }

      const cleanEmail = String(email).trim().toLowerCase();
      const targetUser = await db.collection('users').findOne({ email: cleanEmail });
      if (!targetUser) {
        return reply.status(404).send({ error: 'No user account found matching that email address.' });
      }

      if (targetUser._id === server.ownerId) {
        return reply.status(400).send({ error: 'The server owner cannot be added as a sub-user.' });
      }

      const existingSubUser = await db.collection('server_subusers').findOne({
        serverId,
        userId: targetUser._id
      });
      if (existingSubUser) {
        return reply.status(409).send({ error: 'This user already has sub-user access to this server.' });
      }

      const requestedPermissions = Array.isArray(permissions) ? permissions : [];
      const finalPermissions = applyPermissionDependencies(requestedPermissions);

      if (!actorPerms.isOwner) {
        const hasIllegalPerms = finalPermissions.some((p) => !actorPerms.permissions.includes(p));
        if (hasIllegalPerms) {
          return reply.status(403).send({ error: 'You cannot grant permissions that you do not hold yourself.' });
        }
      }

      const subUserDoc = {
        serverId,
        userId: targetUser._id,
        userEmail: targetUser.email,
        permissions: finalPermissions,
        createdAt: Date.now(),
        createdBy: req.userId
      };

      await db.collection('server_subusers').insertOne(subUserDoc);

      logActivity(req, db, {
        serverId: server.id,
        action: 'server:user.create',
        detail: `Added sub-user ${targetUser.username} (${targetUser.email}) with ${finalPermissions.length} permissions`,
        metadata: { targetUserId: targetUser._id, targetEmail: targetUser.email, permissionsCount: finalPermissions.length }
      });

      return reply.status(201).send({
        success: true,
        message: 'Sub-user added successfully.',
        user: {
          id: targetUser._id,
          email: targetUser.email,
          username: targetUser.username,
          avatarUrl: targetUser.avatarUrl,
          permissions: finalPermissions,
          isOwner: false,
          createdAt: subUserDoc.createdAt
        }
      });
    } catch (err) {
      console.error('[Server Users POST Error]:', err);
      return reply.status(500).send({ error: 'Internal server error.' });
    }
  },
  PUT: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_USERS_PUT', 30, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      const { userId, permissions } = req.body || {};

      if (!serverId || !userId) {
        return reply.status(400).send({ error: 'Server ID and User ID are required.' });
      }

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      if (userId === server.ownerId) {
        return reply.status(400).send({ error: 'Server owner permissions cannot be altered.' });
      }

      const actorPerms = await getUserServerPermissions(req.userId, server, db);
      if (!actorPerms.isOwner && !actorPerms.permissions.includes('users.edit')) {
        return reply.status(403).send({ error: 'Access denied: Requires users.edit permission.' });
      }

      const existingSubUser = await db.collection('server_subusers').findOne({ serverId, userId });
      if (!existingSubUser) {
        return reply.status(404).send({ error: 'Sub-user record not found.' });
      }

      const requestedPermissions = Array.isArray(permissions) ? permissions : [];
      const finalPermissions = applyPermissionDependencies(requestedPermissions);

      if (!actorPerms.isOwner) {
        const hasIllegalPerms = finalPermissions.some((p) => !actorPerms.permissions.includes(p));
        if (hasIllegalPerms) {
          return reply.status(403).send({ error: 'You cannot grant permissions that you do not hold yourself.' });
        }
      }

      const hadConsole = (existingSubUser.permissions || []).includes('overview.console');
      const nowHasConsole = finalPermissions.includes('overview.console');

      const updateRes = await db.collection('server_subusers').updateOne(
        { serverId, userId },
        { $set: { permissions: finalPermissions, updatedAt: Date.now(), updatedBy: req.userId } }
      );

      if (updateRes.matchedCount === 0) {
        return reply.status(404).send({ error: 'Sub-user record not found.' });
      }
      if (hadConsole && !nowHasConsole) {
        const node = await db.collection('nodes').findOne({ id: server.nodeId });
        if (node) {
          revokeDaemonUserWs(node, userId, server.id);
        }
      }

      const targetUser = await db.collection('users').findOne({ _id: userId });

      logActivity(req, db, {
        serverId: server.id,
        action: 'server:user.update',
        detail: `Updated access permissions for sub-user ${targetUser?.username || existingSubUser.userEmail || userId}`,
        metadata: { targetUserId: userId, permissionsCount: finalPermissions.length }
      });

      return reply.status(200).send({
        success: true,
        message: 'Sub-user permissions updated successfully.',
        permissions: finalPermissions
      });
    } catch (err) {
      console.error('[Server Users PUT Error]:', err);
      return reply.status(500).send({ error: 'Internal server error.' });
    }
  },
  DELETE: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_USERS_DELETE', 20, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      const { userId } = req.body || {};

      if (!serverId || !userId) {
        return reply.status(400).send({ error: 'Server ID and User ID are required.' });
      }

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      if (userId === server.ownerId) {
        return reply.status(400).send({ error: 'Server owner cannot be removed.' });
      }

      const actorPerms = await getUserServerPermissions(req.userId, server, db);
      if (!actorPerms.isOwner && !actorPerms.permissions.includes('users.remove')) {
        return reply.status(403).send({ error: 'Access denied: Requires users.remove permission.' });
      }

      const existingSubUser = await db.collection('server_subusers').findOne({ serverId, userId });
      const deleteRes = await db.collection('server_subusers').deleteOne({ serverId, userId });
      if (deleteRes.deletedCount === 0) {
        return reply.status(404).send({ error: 'Sub-user not found on this server.' });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });
      if (node) {
        revokeDaemonUserWs(node, userId, server.id);
      }

      const targetUser = await db.collection('users').findOne({ _id: userId });

      logActivity(req, db, {
        serverId: server.id,
        action: 'server:user.delete',
        detail: `Revoked access and removed sub-user ${targetUser?.username || existingSubUser?.userEmail || userId}`,
        metadata: { targetUserId: userId }
      });

      return reply.status(200).send({
        success: true,
        message: 'Sub-user removed from server successfully.'
      });
    } catch (err) {
      console.error('[Server Users DELETE Error]:', err);
      return reply.status(500).send({ error: 'Internal server error.' });
    }
  }
};