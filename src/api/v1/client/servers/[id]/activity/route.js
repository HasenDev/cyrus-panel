const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');

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

      if (checkRateLimit(reply, req.userId, 'CLIENT_ACTIVITY_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('activity.view')) {
        return reply.status(403).send({ error: 'Access denied: Requires activity.view permission.' });
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const skip = (page - 1) * limit;
      const search = String(req.query.search || '').trim();

      const query = { serverId: server.id };
      if (search) {
        query.$or = [
          { action: { $regex: search, $options: 'i' } },
          { detail: { $regex: search, $options: 'i' } },
          { username: { $regex: search, $options: 'i' } },
          { ip: { $regex: search, $options: 'i' } }
        ];
      }

      const totalCount = await db.collection('server_activities').countDocuments(query);
      const rawActivities = await db.collection('server_activities')
        .find(query)
        .sort({ timestamp: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      const userIds = [...new Set(rawActivities.map((a) => a.userId).filter(Boolean))];
      const users = await db.collection('users').find({ _id: { $in: userIds } }).toArray();
      const userMap = new Map(users.map((u) => [u._id, u]));

      const activities = rawActivities.map((act) => {
        const u = userMap.get(act.userId);
        return {
          id: act._id.toString(),
          userId: act.userId,
          username: u?.username || act.username || 'System Daemon',
          email: u?.email || act.email || '',
          avatarUrl: u?.avatarUrl || act.avatarUrl || null,
          action: act.action || 'server:unknown',
          detail: act.detail || '',
          ip: act.ip || '127.0.0.1',
          metadata: act.metadata || {},
          createdAt: act.createdAt || new Date(act.timestamp || Date.now()).toISOString(),
          timestamp: act.timestamp || new Date(act.createdAt || Date.now()).getTime()
        };
      });

      return reply.status(200).send({
        success: true,
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit) || 1,
        activities
      });
    } catch (err) {
      console.error('[Client Activity GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while fetching activity logs.' });
    }
  }
};