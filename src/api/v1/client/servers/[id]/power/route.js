const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { canAccessServer } = require('../../../../../../lib/serverPermissions');
const { logActivity } = require('../../../../../../lib/logActivity');

module.exports = {
  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_SERVER_POWER', 15, 60000)) return;

      const db = getDB();
      const serverId = req.params?.id || req.body?.serverId;
      const action = req.body?.action;

      if (!serverId || !['start', 'stop', 'restart', 'kill'].includes(action)) {
        return reply.status(400).send({ error: 'Valid server ID and action (start|stop|restart|kill) are required.' });
      }

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const hasPowerPermission = await canAccessServer(req.userId, server, 'overview.power', db);
      if (!hasPowerPermission) {
        return reply.status(403).send({ error: 'Access denied: Requires overview.power permission.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'Power actions cannot be executed while the server is suspended.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'Power actions cannot be executed while the server is installing.' });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });
      if (!node) return reply.status(404).send({ error: 'Node daemon not found.' });

      const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
      const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const port = node.daemonPort || 8080;
      const targetUrl = `${scheme}://${rawFqdn}:${port}/api/servers/${server.id}/power`;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const daemonRes = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${node.daemonKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!daemonRes.ok) {
          const errData = await daemonRes.json().catch(() => ({}));
          return reply.status(400).send({ error: errData.error || 'Node refused power command.' });
        }
        logActivity(req, db, {
          serverId: server.id,
          action: `server:power.${action}`,
          detail: `Sent ${action.toUpperCase()} power signal to container environment`,
          metadata: { action }
        });

        return reply.status(200).send({ success: true, message: `Power action '${action}' dispatched.` });
      } catch (e) {
        return reply.status(502).send({ error: `Node daemon unreachable (${e.message}). Please check node status.` });
      }
    } catch (err) {
      console.error('[Client Power Action Error]:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  }
};