const { getDB } = require('../../../../../lib/db');
const { authenticate } = require('../../../../../lib/auth');
const { getPermissions } = require('../../../../../lib/getPermissions');
const { MAX_EGG_SIZE, validateEggData } = require('../../../../../lib/eggValidator');
const { checkRateLimit } = require('../../../../../lib/rateLimit');

function generateEggId() {
    return 'egg_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NEST_EGGS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const nestId = req.params.id;
            const nest = await db.collection('nests').findOne({ id: nestId });
            if (!nest) {
                return reply.status(404).send({ error: 'Nest not found.' });
            }

            const eggs = await db.collection('eggs').find({ nestId }).toArray();
            const formattedEggs = eggs.map((e) => ({
                id: e.id,
                name: e.name,
                author: e.author || 'Unknown',
                description: e.description || '',
                dockerImagesCount: Object.keys(e.docker_images || {}).length,
                variablesCount: (e.variables || []).length,
                createdAt: e.createdAt,
                rawJson: e.rawJson
            }));

            return reply.status(200).send({
                nest: { id: nest.id, name: nest.name, createdAt: nest.createdAt },
                eggs: formattedEggs
            });
        } catch (err) {
            console.error('[Admin Nest Details GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NEST_EGGS_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const nestId = req.params.id;
            const nest = await db.collection('nests').findOne({ id: nestId });
            if (!nest) {
                return reply.status(404).send({ error: 'Nest not found.' });
            }

            let eggJsonString = '';
            let customName = '';
            let customDescription = '';

            if (req.isMultipart && req.isMultipart()) {
                const parts = req.parts();
                for await (const part of parts) {
                    if (part.type === 'file') {
                        const chunks = [];
                        let totalBytes = 0;
                        for await (const chunk of part.file) {
                            totalBytes += chunk.length;
                            if (totalBytes > MAX_EGG_SIZE) {
                                return reply.status(400).send({ error: 'Egg JSON file exceeds the maximum size limit of 100KB.' });
                            }
                            chunks.push(chunk);
                        }
                        eggJsonString = Buffer.concat(chunks).toString('utf8');
                    } else {
                        if (part.fieldname === 'name') customName = String(part.value || '').trim();
                        if (part.fieldname === 'description') customDescription = String(part.value || '').trim();
                    }
                }
            } else if (typeof req.body === 'object' && req.body !== null) {
                if (req.body.eggJson) {
                    eggJsonString = typeof req.body.eggJson === 'string'
                        ? req.body.eggJson
                        : JSON.stringify(req.body.eggJson);
                }
                if (typeof req.body.name === 'string') customName = req.body.name.trim();
                if (typeof req.body.description === 'string') customDescription = req.body.description.trim();
            } else if (typeof req.body === 'string') {
                eggJsonString = req.body;
            }

            if (!eggJsonString) {
                return reply.status(400).send({ error: 'Invalid payload. Provide an Egg JSON file or eggJson string.' });
            }

            if (Buffer.byteLength(eggJsonString, 'utf8') > MAX_EGG_SIZE) {
                return reply.status(400).send({ error: 'Egg JSON payload exceeds the maximum 100KB limit.' });
            }

            let parsedEgg;
            try {
                parsedEgg = JSON.parse(eggJsonString);
            } catch {
                return reply.status(400).send({ error: 'Malformed JSON payload: Failed to parse Egg file.' });
            }

            try {
                validateEggData(parsedEgg);
            } catch (valErr) {
                return reply.status(400).send({ error: valErr.message });
            }

            const finalName = customName || parsedEgg.name.trim();
            const finalDescription = customDescription !== '' ? customDescription : (parsedEgg.description || '');

            parsedEgg.name = finalName;
            parsedEgg.description = finalDescription;

            const eggDoc = {
                id: generateEggId(),
                nestId,
                name: finalName,
                author: parsedEgg.author || 'Unknown',
                description: finalDescription,
                docker_images: parsedEgg.docker_images,
                startup: parsedEgg.startup,
                config: parsedEgg.config || {},
                scripts: parsedEgg.scripts || {},
                variables: parsedEgg.variables || [],
                rawJson: parsedEgg,
                createdAt: new Date().toISOString()
            };

            await db.collection('eggs').insertOne(eggDoc);

            return reply.status(201).send({
                success: true,
                message: `Egg "${eggDoc.name}" imported successfully.`,
                egg: {
                    id: eggDoc.id,
                    name: eggDoc.name,
                    author: eggDoc.author,
                    description: eggDoc.description
                }
            });
        } catch (err) {
            console.error('[Admin Egg Import Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NEST_EGGS_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const nestId = req.params.id;
            const { eggId, name, description, eggJson } = req.body || {};

            if (!eggId || typeof eggId !== 'string') {
                return reply.status(400).send({ error: 'Egg ID is required.' });
            }

            const existingEgg = await db.collection('eggs').findOne({ id: eggId, nestId });
            if (!existingEgg) {
                return reply.status(404).send({ error: 'Egg not found in this nest.' });
            }

            const updates = {};

            if (eggJson) {
                const jsonStr = typeof eggJson === 'string' ? eggJson : JSON.stringify(eggJson);

                if (Buffer.byteLength(jsonStr, 'utf8') > MAX_EGG_SIZE) {
                    return reply.status(400).send({ error: 'Updated JSON exceeds the maximum size limit of 100KB.' });
                }

                let parsedEgg;
                try {
                    parsedEgg = JSON.parse(jsonStr);
                } catch {
                    return reply.status(400).send({ error: 'Invalid JSON format in advanced editor.' });
                }

                try {
                    validateEggData(parsedEgg);
                } catch (valErr) {
                    return reply.status(400).send({ error: valErr.message });
                }

                if (typeof name === 'string' && name.trim()) parsedEgg.name = name.trim();
                if (typeof description === 'string') parsedEgg.description = description.trim();

                updates.name = parsedEgg.name;
                updates.description = parsedEgg.description;
                updates.author = parsedEgg.author || existingEgg.author;
                updates.docker_images = parsedEgg.docker_images;
                updates.startup = parsedEgg.startup;
                updates.config = parsedEgg.config || {};
                updates.scripts = parsedEgg.scripts || {};
                updates.variables = parsedEgg.variables || [];
                updates.rawJson = parsedEgg;
            } else {
                let rawJsonUpdated = { ...existingEgg.rawJson };

                if (typeof name === 'string' && name.trim()) {
                    updates.name = name.trim();
                    rawJsonUpdated.name = name.trim();
                }
                if (typeof description === 'string') {
                    updates.description = description.trim();
                    rawJsonUpdated.description = description.trim();
                }

                updates.rawJson = rawJsonUpdated;
            }

            if (Object.keys(updates).length === 0) {
                return reply.status(400).send({ error: 'No fields provided to update.' });
            }

            await db.collection('eggs').updateOne({ id: eggId, nestId }, { $set: updates });

            return reply.status(200).send({ success: true, message: 'Egg updated successfully.' });
        } catch (err) {
            console.error('[Admin Egg PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NEST_EGGS_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const nestId = req.params.id;
            const { eggId } = req.body || {};

            if (!eggId || typeof eggId !== 'string') {
                return reply.status(400).send({ error: 'Egg ID is required.' });
            }

            const existingEgg = await db.collection('eggs').findOne({ id: eggId, nestId });
            if (!existingEgg) {
                return reply.status(404).send({ error: 'Egg not found in this nest.' });
            }
            const serverCount = await db.collection('servers').countDocuments({ eggId });
            if (serverCount > 0) {
                return reply.status(400).send({
                    error: `Cannot delete Egg "${existingEgg.name}": It is currently assigned to ${serverCount} active server(s). Delete or reassign those servers first.`
                });
            }
            const packageCount = await db.collection('packages').countDocuments({ eggId });
            if (packageCount > 0) {
                return reply.status(400).send({
                    error: `Cannot delete Egg "${existingEgg.name}": It is currently configured in ${packageCount} deployable package(s). Update or delete those packages first.`
                });
            }

            const result = await db.collection('eggs').deleteOne({ id: eggId, nestId });
            if (result.deletedCount === 0) {
                return reply.status(404).send({ error: 'Egg not found.' });
            }

            return reply.status(200).send({
                success: true,
                message: `Egg "${existingEgg.name}" deleted successfully.`
            });
        } catch (err) {
            console.error('[Admin Egg DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};