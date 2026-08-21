const PERMISSIONS = [
    'ADMIN_OVERVIEW',
    'ADMIN_SETTINGS',
    'ADMIN_LOCATIONS',
    'ADMIN_VOUCHERS',
    'ADMIN_NODES',
    'ADMIN_SERVERS',
    'ADMIN_PAYMENT',
    'ADMIN_PACKAGES',
    'ADMIN_ANNOUNCEMENTS',
    'ADMIN_USERS',
    'ADMIN_NESTS'
];
function getAccessLevel(user) {
    if (!user) return 'Client';
    if (user.developer === true || user.role === 'developer') {
        return 'Developer';
    }
    if (user.admin === true) {
        return 'Admin';
    }

    const userPerms = Array.isArray(user.permissions) ? user.permissions : [];
    const hasAllPermissions = PERMISSIONS.length > 0 && PERMISSIONS.every(perm => userPerms.includes(perm));
    if (hasAllPermissions) {
        return 'Admin';
    }
    const hasSomePermissions = PERMISSIONS.some(perm => userPerms.includes(perm));
    if (hasSomePermissions) {
        return 'Moderator';
    }

    return 'Client';
}

module.exports = { PERMISSIONS, getAccessLevel };