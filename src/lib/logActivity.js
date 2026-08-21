const crypto = require('crypto');
const { getClientIp } = require('./getIP');
const recentActivities = new Map();
const DEDUPLICATION_WINDOW_MS = 5000;
const GC_INTERVAL_MS = 60000;
setInterval(() => {
  const now = Date.now();
  for (const [hash, timestamp] of recentActivities.entries()) {
    if (now - timestamp > DEDUPLICATION_WINDOW_MS) {
      recentActivities.delete(hash);
    }
  }
}, GC_INTERVAL_MS).unref();
function createActivityFingerprint(serverId, userId, action, detail, metadata, ip) {
  const payload = JSON.stringify({
    serverId: String(serverId),
    userId: String(userId),
    action: String(action),
    detail: String(detail || ''),
    metadata: metadata || {},
    ip: String(ip)
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}
function isDuplicateActivity(fingerprint) {
  const now = Date.now();
  const lastLoggedAt = recentActivities.get(fingerprint);

  if (lastLoggedAt && now - lastLoggedAt < DEDUPLICATION_WINDOW_MS) {
    return true;
  }

  recentActivities.set(fingerprint, now);
  return false;
}
async function logActivity(req, db, { serverId, action, detail = '', metadata = {}, userId = null }) {
  try {
    if (!db || !serverId || !action) return;

    const actorId = userId || req?.userId || null;
    const ip = getClientIp(req);
    const fingerprint = createActivityFingerprint(serverId, actorId || 'system', action, detail, metadata, ip);
    if (isDuplicateActivity(fingerprint)) {
      return;
    }

    let userDoc = null;
    if (actorId) {
      userDoc = await db.collection('users').findOne({ _id: actorId });
    }

    const now = new Date();
    await db.collection('server_activities').insertOne({
      serverId,
      userId: actorId || 'system',
      username: userDoc?.username || (actorId ? 'Unknown User' : 'System Daemon'),
      email: userDoc?.email || '',
      avatarUrl: userDoc?.avatarUrl || null,
      action,
      detail,
      ip,
      metadata,
      createdAt: now.toISOString(),
      timestamp: now.getTime()
    });
  } catch (err) {
    console.error('[logActivity Error]:', err?.message || err);
  }
}

module.exports = {
  getClientIp,
  logActivity
};