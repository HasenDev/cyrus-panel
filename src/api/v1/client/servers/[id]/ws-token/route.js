const jwt = require('jsonwebtoken');
const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
const { logActivity } = require('../../../../../../lib/logActivity');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = {
  GET: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_WS_TOKEN', 30, 60000)) return;

      const db = getDB();
      const serverId = req.params?.id || req.query?.serverId;
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) {
        return reply.status(404).send({ error: 'Server not found or access denied.' });
      }

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      const canConsole = isOwner || permissions.includes('overview.console');
      const canPower = isOwner || permissions.includes('overview.power');

      if (!canConsole && !canPower) {
        return reply.status(403).send({ error: 'Access denied: Requires overview permissions.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'WebSocket console connection is unavailable while server is suspended.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'WebSocket console connection is unavailable while server is installing.' });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });
      if (!node) return reply.status(404).send({ error: 'Server node not found.' });

      const user = await db.collection('users').findOne({ _id: req.userId });
      if (!user) return reply.status(404).send({ error: 'User not found.' });

      const passwordChangedAt = user.passwordChangedAt ? new Date(user.passwordChangedAt).getTime() : 0;
      const expiresAt = Math.floor(Date.now() / 1000) + (5 * 3600);

      const token = jwt.sign(
        {
          userId: user._id,
          serverId: server.id,
          nodeId: node.id,
          passwordChangedAt,
          canConsole,
          canPower,
          exp: expiresAt
        },
        JWT_SECRET
      );

      const scheme = node.scheme || 'https';
      const wsProtocol = scheme === 'https' ? 'wss' : 'ws';
      const socketUrl = `${wsProtocol}://${node.fqdn}:${node.daemonPort || 8080}/client/ws`;
      logActivity(req, db, {
        serverId: server.id,
        action: 'server:console.connect',
        detail: 'Connected to server interactive console session'
      });

      return reply.status(200).send({
        success: true,
        token,
        socketUrl,
        canConsole,
        canPower,
        expiresAt: expiresAt * 1000
      });
    } catch (err) {
      console.error('[Console Token Error]:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  }
};