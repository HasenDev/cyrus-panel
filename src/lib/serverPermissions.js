const path = require('path');
let getPermissions;
try {
  getPermissions = require('./getPermissions').getPermissions || require('./getPermissions');
} catch {
  try {
    getPermissions = require('../lib/getPermissions').getPermissions || require('../lib/getPermissions');
  } catch {
    getPermissions = (user) => (user && Array.isArray(user.permissions) ? user.permissions : []);
  }
}

const ALL_PERMISSIONS = [
  'overview.power',
  'overview.console',
  'files.create',
  'files.upload',
  'files.download',
  'files.archiving',
  'files.content',
  'files.editfile',
  'files.move',
  'network.view',
  'network.manage',
  'startup.view',
  'startup.manage',
  'payment.view',
  'payment.manage',
  'users.view',
  'users.add',
  'users.edit',
  'users.remove',
  'settings.view',
  'settings.change.info',
  'settings.reinstall',
  'activity.view'
];

const CATEGORY_MAP = {
  overview: ['overview.power', 'overview.console'],
  files: [
    'files.create',
    'files.upload',
    'files.download',
    'files.archiving',
    'files.content',
    'files.editfile',
    'files.move'
  ],
  network: ['network.view', 'network.manage'],
  startup: ['startup.view', 'startup.manage'],
  payment: ['payment.view', 'payment.manage'],
  users: ['users.view', 'users.add', 'users.edit', 'users.remove'],
  settings: ['settings.view', 'settings.change.info', 'settings.reinstall'],
  activity: ['activity.view']
};
function normalizePermissions(permissions = []) {
  const permSet = new Set(permissions.filter(p => ALL_PERMISSIONS.includes(p)));

  ['network', 'startup', 'payment', 'users', 'settings', 'activity'].forEach(cat => {
    const hasCatPerm = Array.from(permSet).some(p => p.startsWith(`${cat}.`));
    if (hasCatPerm) {
      permSet.add(`${cat}.view`);
    }
  });

  return Array.from(permSet);
}
async function getUserServerPermissions(userOrId, server, db) {
  if (!userOrId || !server) {
    return { isOwner: false, isAdmin: false, permissions: [] };
  }
  let user = null;
  let userId = null;
  if (typeof userOrId === 'object' && userOrId !== null) {
    user = userOrId;
    userId = String(user._id || user.id || '');
  } else {
    userId = String(userOrId);
    if (db) {
      user = await db.collection('users').findOne({
        $or: [{ _id: userOrId }, { id: userOrId }]
      });
    }
  }
  if (user) {
    const globalPerms = typeof getPermissions === 'function' ? getPermissions(user) : [];
    if (Array.isArray(globalPerms) && (globalPerms.includes('ADMIN_SERVERS') || globalPerms.includes('*'))) {
      return {
        isOwner: true,
        isAdmin: true,
        permissions: [...ALL_PERMISSIONS]
      };
    }
  }
  const serverOwnerId = String(server.ownerId || '');
  if (userId && serverOwnerId === userId) {
    return {
      isOwner: true,
      isAdmin: false,
      permissions: [...ALL_PERMISSIONS]
    };
  }
  if (!db) {
    return { isOwner: false, isAdmin: false, permissions: [] };
  }
  const serverId = String(server.id || server._id || '');
  const subUser = await db.collection('server_subusers').findOne({
    serverId: serverId,
    $or: [{ userId: userId }, { userId: userOrId }]
  });

  if (!subUser) {
    return { isOwner: false, isAdmin: false, permissions: [] };
  }

  return {
    isOwner: false,
    isAdmin: false,
    permissions: normalizePermissions(subUser.permissions || [])
  };
}
async function canAccessServer(userOrId, server, requiredPermission, db) {
  if (!userOrId || !server) return false;

  const { isOwner, isAdmin, permissions } = await getUserServerPermissions(userOrId, server, db);
  if (isAdmin || isOwner) {
    return true;
  }

  if (!requiredPermission) {
    return permissions.length > 0;
  }

  return permissions.includes(requiredPermission);
}

module.exports = {
  ALL_PERMISSIONS,
  CATEGORY_MAP,
  normalizePermissions,
  getUserServerPermissions,
  canAccessServer
};
