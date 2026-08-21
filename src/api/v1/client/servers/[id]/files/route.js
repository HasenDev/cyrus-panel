const jwt = require('jsonwebtoken');
const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
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

module.exports = {
  GET: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;
      if (checkRateLimit(reply, req.userId, 'CLIENT_FILES_GET', 120, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);

      const hasAnyFilePerm = isOwner || permissions.some((p) => p.startsWith('files.'));
      if (!hasAnyFilePerm) {
        return reply.status(403).send({ error: 'Access denied: You do not have permission to view server files.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'File manager is unavailable while the server is suspended.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'File manager is unavailable while the server is installing.' });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });
      if (!node) return reply.status(404).send({ error: 'Node daemon not found.' });

      const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
      const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const port = node.daemonPort || 8080;
      const nodeUploadLimitMB = Math.min(node.uploadSize || 100, 1024);

      if (req.query.action === 'download-url') {
        if (!isOwner && !permissions.includes('files.download')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.download permission.' });
        }

        const filePath = req.query.file;
        if (!filePath) return reply.status(400).send({ error: 'File parameter is required.' });

        const token = jwt.sign(
          { serverId: server.id, file: filePath, action: 'download' },
          node.daemonKey,
          { expiresIn: '5h' }
        );

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:file.download',
          detail: `Requested download for ${filePath}`,
          metadata: { file: filePath }
        });

        const downloadUrl = `${scheme}://${rawFqdn}:${port}/api/client/files/download?token=${token}`;
        return reply.status(200).send({ url: downloadUrl });
      }

      if (req.query.action === 'upload-url') {
        if (!isOwner && !permissions.includes('files.upload')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.upload permission.' });
        }

        let currentUsageBytes = 0;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const usageRes = await fetch(`${scheme}://${rawFqdn}:${port}/api/servers/${server.id}/files?action=usage`, {
            headers: { 'Authorization': `Bearer ${node.daemonKey}` },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (usageRes.ok) {
            const data = await usageRes.json();
            currentUsageBytes = data.usageBytes || 0;
          }
        } catch {}

        const maxBytes = (server.disk || 0) * 1024 * 1024;
        if (maxBytes > 0 && currentUsageBytes >= maxBytes) {
          return reply.status(403).send({ error: 'Server storage limit reached.' });
        }

        const remainingMB = maxBytes > 0 ? Math.floor((maxBytes - currentUsageBytes) / (1024 * 1024)) : nodeUploadLimitMB;
        const effectiveUploadLimitMB = Math.max(0, Math.min(nodeUploadLimitMB, remainingMB));

        if (maxBytes > 0 && effectiveUploadLimitMB <= 0) {
          return reply.status(403).send({ error: 'Not enough storage space available for uploads.' });
        }

        const directory = req.query.directory || '/';
        const token = jwt.sign(
          { serverId: server.id, directory, action: 'upload', maxSizeMB: effectiveUploadLimitMB },
          node.daemonKey,
          { expiresIn: '5h' }
        );

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:file.upload',
          detail: `Generated upload authorization for directory ${directory}`,
          metadata: { directory }
        });

        const uploadUrl = `${scheme}://${rawFqdn}:${port}/api/client/files/upload?token=${token}`;
        return reply.status(200).send({
          url: uploadUrl,
          maxSizeMB: effectiveUploadLimitMB
        });
      }

      if (req.query.action === 'content') {
        const canRead = isOwner || permissions.includes('files.content') || permissions.includes('files.editfile');
        if (!canRead) {
          return reply.status(403).send({ error: 'Access denied: Requires files.content permission.' });
        }

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:file.read',
          detail: `Read content of ${req.query.file}`,
          metadata: { file: req.query.file }
        });
      }

      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('serverId');
      const targetUrl = `${scheme}://${rawFqdn}:${port}/api/servers/${server.id}/files?${queryParams.toString()}`;

      let daemonRes;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        daemonRes = await fetch(targetUrl, {
          headers: { 'Authorization': `Bearer ${node.daemonKey}` },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch {
        return reply.status(502).send({ error: 'The daemon failed to respond. Please try again in a few seconds.' });
      }

      const rawText = await daemonRes.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        return reply.status(502).send({ error: 'The daemon failed to respond with valid data.' });
      }

      return reply.status(daemonRes.status).send(data);
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to communicate with daemon.' });
    }
  },

  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;
      if (checkRateLimit(reply, req.userId, 'CLIENT_FILES_POST', 90, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);

      if (server.suspended) {
        return reply.status(403).send({ error: 'File operations are disabled while the server is suspended.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'File operations are disabled while the server is installing.' });
      }

      const { action } = req.body || {};
      if (!action) return reply.status(400).send({ error: 'Action parameter is required.' });

      let auditAction = `server:file.${action}`;
      let auditDetail = `Executed ${action} file operation`;

      if (action === 'write') {
        const canWrite = isOwner || permissions.includes('files.editfile') || permissions.includes('files.create');
        if (!canWrite) {
          return reply.status(403).send({ error: 'Access denied: Requires files.editfile or files.create permission.' });
        }
        auditAction = 'server:file.write';
        auditDetail = `Wrote content to ${req.body?.file || 'file'}`;
      } else if (action === 'create-folder') {
        if (!isOwner && !permissions.includes('files.create')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.create permission.' });
        }
        auditAction = 'server:file.create_directory';
        auditDetail = `Created directory ${req.body?.name} in ${req.body?.directory || '/'}`;
      } else if (action === 'delete') {
        if (!isOwner && !permissions.includes('files.move')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.move permission to delete files.' });
        }
        const fileList = Array.isArray(req.body?.files) ? req.body.files.join(', ') : 'files';
        auditAction = 'server:file.delete';
        auditDetail = `Deleted ${fileList} in ${req.body?.root || '/'}`;
      } else if (action === 'rename') {
        const canRename = isOwner || permissions.includes('files.editfile') || permissions.includes('files.move');
        if (!canRename) {
          return reply.status(403).send({ error: 'Access denied: Requires files.editfile or files.move permission.' });
        }
        auditAction = 'server:file.rename';
        auditDetail = `Renamed ${req.body?.from} to ${req.body?.to}`;
      } else if (action === 'move') {
        if (!isOwner && !permissions.includes('files.move')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.move permission.' });
        }
        auditAction = 'server:file.move';
        auditDetail = `Moved ${req.body?.from} to ${req.body?.to}`;
      } else if (action === 'copy') {
        const canCopy = isOwner || permissions.includes('files.create') || permissions.includes('files.move');
        if (!canCopy) {
          return reply.status(403).send({ error: 'Access denied: Requires files.create or files.move permission.' });
        }
        auditAction = 'server:file.copy';
        auditDetail = `Copied ${req.body?.file}`;
      } else if (action === 'chmod') {
        if (!isOwner && !permissions.includes('files.editfile')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.editfile permission to modify permissions.' });
        }
        auditAction = 'server:file.chmod';
        auditDetail = `Changed permissions of ${req.body?.file} to ${req.body?.mode}`;
      } else if (action === 'archive') {
        if (!isOwner && !permissions.includes('files.archiving')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.archiving permission.' });
        }
        auditAction = 'server:file.archive';
        auditDetail = `Compressed ${(req.body?.files || []).join(', ')} into archive`;
      } else if (action === 'unarchive') {
        if (!isOwner && !permissions.includes('files.archiving')) {
          return reply.status(403).send({ error: 'Access denied: Requires files.archiving permission.' });
        }
        auditAction = 'server:file.unarchive';
        auditDetail = `Extracted archive ${req.body?.file}`;
      } else {
        return reply.status(400).send({ error: `Unknown file action: ${action}` });
      }

      const node = await db.collection('nodes').findOne({ id: server.nodeId });
      if (!node) return reply.status(404).send({ error: 'Node daemon not found.' });

      const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
      const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const port = node.daemonPort || 8080;
      const targetUrl = `${scheme}://${rawFqdn}:${port}/api/servers/${server.id}/files`;

      const proxiedBody = { ...req.body, diskLimitMB: server.disk || 0 };

      let daemonRes;
      try {
        daemonRes = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${node.daemonKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(proxiedBody)
        });
      } catch {
        return reply.status(502).send({ error: 'The daemon failed to respond.' });
      }

      const rawText = await daemonRes.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        return reply.status(502).send({ error: 'The daemon returned an invalid response.' });
      }

      if (daemonRes.ok) {
        logActivity(req, db, {
          serverId: server.id,
          action: auditAction,
          detail: auditDetail,
          metadata: req.body
        });
      }

      return reply.status(daemonRes.status).send(data);
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to process file operation.' });
    }
  }
};