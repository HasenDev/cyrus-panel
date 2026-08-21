const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function generateLocationId() {
    return 'loc_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_LOCATIONS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_LOCATIONS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_LOCATIONS permission.' });
            }

            const locations = await db.collection('locations').find({}).toArray();

            const formattedLocations = locations.map(loc => ({
                id: loc.id || loc._id.toString(),
                name: loc.name,
                flag: loc.flag,
                createdAt: loc.createdAt
            }));

            return reply.status(200).send({ locations: formattedLocations });
        } catch (err) {
            console.error('[Admin Locations GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_LOCATIONS_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_LOCATIONS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_LOCATIONS permission.' });
            }

            const { name, flag } = req.body || {};

            if (!name || typeof name !== 'string' || !name.trim()) {
                return reply.status(400).send({ error: 'Location name is required.' });
            }

            if (!flag || typeof flag !== 'string' || !flag.trim()) {
                return reply.status(400).send({ error: 'Location flag country code is required.' });
            }

            const newLocation = {
                id: generateLocationId(),
                name: name.trim(),
                flag: flag.trim().toUpperCase(),
                createdAt: new Date().toISOString()
            };

            await db.collection('locations').insertOne(newLocation);

            return reply.status(201).send({
                success: true,
                message: 'Location created successfully.',
                location: newLocation
            });
        } catch (err) {
            console.error('[Admin Locations POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_LOCATIONS_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_LOCATIONS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_LOCATIONS permission.' });
            }

            const { id, name, flag } = req.body || {};

            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Location ID is required.' });
            }

            const updateData = {};
            if (typeof name === 'string' && name.trim()) updateData.name = name.trim();
            if (typeof flag === 'string' && flag.trim()) updateData.flag = flag.trim().toUpperCase();

            if (Object.keys(updateData).length === 0) {
                return reply.status(400).send({ error: 'No updated fields provided.' });
            }

            const result = await db.collection('locations').updateOne(
                { id },
                { $set: updateData }
            );

            if (result.matchedCount === 0) {
                return reply.status(404).send({ error: 'Location not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Location updated successfully.' });
        } catch (err) {
            console.error('[Admin Locations PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_LOCATIONS_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_LOCATIONS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_LOCATIONS permission.' });
            }

            const { id } = req.body || {};

            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Location ID is required.' });
            }

            const result = await db.collection('locations').deleteOne({ id });

            if (result.deletedCount === 0) {
                return reply.status(404).send({ error: 'Location not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Location deleted successfully.' });
        } catch (err) {
            console.error('[Admin Locations DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};