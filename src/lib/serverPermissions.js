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

async function getUserServerPermissions(userId, server, db) {
  if (!userId || !server) {
    return { isOwner: false, permissions: [] };
  }

  if (server.ownerId === userId) {
    return { isOwner: true, permissions: [...ALL_PERMISSIONS] };
  }

  const subUser = await db.collection('server_subusers').findOne({
    serverId: server.id,
    userId
  });

  if (!subUser) {
    return { isOwner: false, permissions: [] };
  }

  return {
    isOwner: false,
    permissions: normalizePermissions(subUser.permissions || [])
  };
}
async function canAccessServer(userId, server, requiredPermission, db) {
  if (!userId || !server) return false;
  if (server.ownerId === userId) return true;

  const { permissions } = await getUserServerPermissions(userId, server, db);
  if (!requiredPermission) return permissions.length > 0;

  return permissions.includes(requiredPermission);
}

module.exports = {
  ALL_PERMISSIONS,
  CATEGORY_MAP,
  normalizePermissions,
  getUserServerPermissions,
  canAccessServer
};