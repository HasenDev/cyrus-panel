const { PERMISSIONS } = require('./permissions');
function getPermissions(user) {
    if (!user) return [];
    if (user.admin === true) {
        return PERMISSIONS;
    }
    return Array.isArray(user.permissions) ? user.permissions : [];
}

module.exports = { getPermissions };