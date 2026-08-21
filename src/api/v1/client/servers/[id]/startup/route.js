const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
const { validateVariable, validateDockerImage } = require('../../../../../../lib/variableValidator');
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

      if (checkRateLimit(reply, req.userId, 'CLIENT_STARTUP_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('startup.view')) {
        return reply.status(403).send({ error: 'Access denied: Requires startup.view permission.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'Startup configuration is unavailable while the server is suspended.' });
      }

      const egg = await db.collection('eggs').findOne({ id: server.eggId });
      if (!egg) return reply.status(404).send({ error: 'Egg template configuration not found.' });

      let dockerImages = {};
      if (egg.docker_images && typeof egg.docker_images === 'object') {
        dockerImages = egg.docker_images;
      } else if (egg.docker_image) {
        dockerImages = { Default: egg.docker_image };
      }

      const rawVariables = Array.isArray(egg.variables) ? egg.variables : [];
      const formattedVariables = rawVariables
        .filter((v) => v.user_viewable !== false)
        .map((v) => {
          const key = v.env_variable;
          const currentValue = server.env && server.env[key] !== undefined
            ? String(server.env[key])
            : String(v.default_value || '');

          return {
            name: v.name || key,
            description: v.description || '',
            envVariable: key,
            defaultValue: String(v.default_value || ''),
            userViewable: Boolean(v.user_viewable ?? true),
            userEditable: Boolean(v.user_editable ?? true),
            rules: String(v.rules || ''),
            value: currentValue
          };
        });

      const rawStartup = server.startup || egg.startup || '';

      return reply.status(200).send({
        startup: rawStartup,
        rawStartup: egg.startup || '',
        dockerImage: server.dockerImage || Object.values(dockerImages)[0] || 'ubuntu:latest',
        dockerImages,
        variables: formattedVariables,
        canManage: isOwner || permissions.includes('startup.manage')
      });
    } catch (err) {
      console.error('[Client Startup GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while fetching startup configuration.' });
    }
  },

  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_STARTUP_POST', 30, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('startup.manage')) {
        return reply.status(403).send({ error: 'Access denied: Requires startup.manage permission.' });
      }

      if (server.suspended) {
        return reply.status(403).send({ error: 'Startup configuration cannot be modified while server is suspended.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'Startup configuration cannot be modified while server is installing.' });
      }

      const egg = await db.collection('eggs').findOne({ id: server.eggId });
      if (!egg) return reply.status(404).send({ error: 'Egg template configuration not found.' });

      const { dockerImage, environment } = req.body || {};
      const updateDoc = {};

      if (dockerImage !== undefined) {
        const imgValidation = validateDockerImage(egg, dockerImage);
        if (!imgValidation.valid) {
          return reply.status(400).send({ error: imgValidation.error });
        }
        updateDoc.dockerImage = imgValidation.image;

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:startup.image',
          detail: `Switched Docker container runtime image to ${imgValidation.image}`,
          metadata: { dockerImage: imgValidation.image }
        });
      }

      if (environment !== undefined) {
        if (typeof environment !== 'object' || Array.isArray(environment) || environment === null) {
          return reply.status(400).send({ error: 'Environment variables payload must be an object.' });
        }

        const rawVariables = Array.isArray(egg.variables) ? egg.variables : [];
        const updatedEnv = { ...(server.env || {}) };
        const changedKeys = [];

        for (const v of rawVariables) {
          const key = v.env_variable;
          if (v.user_editable === false) {
            continue;
          }

          if (Object.prototype.hasOwnProperty.call(environment, key)) {
            const validation = validateVariable(v, environment[key]);

            if (!validation.valid) {
              return reply.status(422).send({
                error: validation.error,
                variable: key
              });
            }

            if (updatedEnv[key] !== validation.value) {
              changedKeys.push(key);
            }
            updatedEnv[key] = validation.value;
          }
        }

        updateDoc.env = updatedEnv;

        if (changedKeys.length > 0) {
          logActivity(req, db, {
            serverId: server.id,
            action: 'server:startup.variables',
            detail: `Modified ${changedKeys.length} egg variable(s): ${changedKeys.join(', ')}`,
            metadata: { modifiedVariables: changedKeys }
          });
        }
      }

      if (Object.keys(updateDoc).length === 0) {
        return reply.status(400).send({ error: 'No valid startup configuration fields provided to update.' });
      }

      await db.collection('servers').updateOne(
        { id: server.id },
        { $set: updateDoc }
      );

      return reply.status(200).send({
        success: true,
        message: 'Startup configuration updated successfully. Please restart your server to apply changes.'
      });
    } catch (err) {
      console.error('[Client Startup POST Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while saving startup configuration.' });
    }
  }
};