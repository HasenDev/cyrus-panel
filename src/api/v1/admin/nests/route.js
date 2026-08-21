const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function generateNestId() {
    return 'nest_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NESTS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const nests = await db.collection('nests').find({}).toArray();
            const eggs = await db.collection('eggs').find({}).toArray();

            const eggCounts = {};
            eggs.forEach((egg) => {
                eggCounts[egg.nestId] = (eggCounts[egg.nestId] || 0) + 1;
            });

            const formattedNests = nests.map((n) => ({
                id: n.id || n._id.toString(),
                name: n.name,
                eggCount: eggCounts[n.id] || 0,
                createdAt: n.createdAt
            }));

            return reply.status(200).send({ nests: formattedNests });
        } catch (err) {
            console.error('[Admin Nests GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NESTS_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const { name } = req.body || {};
            if (!name || typeof name !== 'string' || !name.trim()) {
                return reply.status(400).send({ error: 'Nest name is required.' });
            }

            const nestId = generateNestId();
            const newNest = {
                id: nestId,
                name: name.trim(),
                createdAt: new Date().toISOString()
            };

            await db.collection('nests').insertOne(newNest);

            return reply.status(201).send({
                success: true,
                message: 'Nest created successfully.',
                nest: newNest
            });
        } catch (err) {
            console.error('[Admin Nests POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NESTS_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const { id, name } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Nest ID is required.' });
            }
            if (!name || typeof name !== 'string' || !name.trim()) {
                return reply.status(400).send({ error: 'Nest name cannot be empty.' });
            }

            const result = await db.collection('nests').updateOne(
                { id },
                { $set: { name: name.trim() } }
            );

            if (result.matchedCount === 0) {
                return reply.status(404).send({ error: 'Nest not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Nest updated successfully.' });
        } catch (err) {
            console.error('[Admin Nests PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_NESTS_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_NESTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_NESTS permission.' });
            }

            const { id } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Nest ID is required.' });
            }

            const nest = await db.collection('nests').findOne({ id });
            if (!nest) {
                return reply.status(404).send({ error: 'Nest not found.' });
            }
            const serverCount = await db.collection('servers').countDocuments({ nestId: id });
            if (serverCount > 0) {
                return reply.status(400).send({
                    error: `Cannot delete Nest "${nest.name}": It is currently in use by ${serverCount} active server(s). Delete or reassign those servers first.`
                });
            }
            const packageCount = await db.collection('packages').countDocuments({ nestId: id });
            if (packageCount > 0) {
                return reply.status(400).send({
                    error: `Cannot delete Nest "${nest.name}": It is currently configured in ${packageCount} deployable package(s). Update or delete those packages first.`
                });
            }
            const nestEggs = await db.collection('eggs').find({ nestId: id }).toArray();
            const eggIds = nestEggs.map((e) => e.id);

            if (eggIds.length > 0) {
                const eggsInServersCount = await db.collection('servers').countDocuments({ eggId: { $in: eggIds } });
                if (eggsInServersCount > 0) {
                    return reply.status(400).send({
                        error: `Cannot delete Nest "${nest.name}": Contains eggs currently used by ${eggsInServersCount} active server(s).`
                    });
                }

                const eggsInPackagesCount = await db.collection('packages').countDocuments({ eggId: { $in: eggIds } });
                if (eggsInPackagesCount > 0) {
                    return reply.status(400).send({
                        error: `Cannot delete Nest "${nest.name}": Contains eggs configured in ${eggsInPackagesCount} package(s).`
                    });
                }
            }
            await db.collection('nests').deleteOne({ id });
            await db.collection('eggs').deleteMany({ nestId: id });

            return reply.status(200).send({
                success: true,
                message: `Nest "${nest.name}" and all associated eggs deleted successfully.`
            });
        } catch (err) {
            console.error('[Admin Nests DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};