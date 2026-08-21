const { getDB } = require('../../../../../lib/db');
const { authenticate } = require('../../../../../lib/auth');
const { getPermissions } = require('../../../../../lib/getPermissions');
const { checkRateLimit } = require('../../../../../lib/rateLimit');

function generateCategoryId() {
    return 'pkg_cat_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGE_CATEGORIES_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const categories = await db.collection('package_categories').find({}).toArray();
            const packages = await db.collection('packages').find({}).toArray();

            const pkgCounts = {};
            packages.forEach(pkg => {
                pkgCounts[pkg.categoryId] = (pkgCounts[pkg.categoryId] || 0) + 1;
            });

            const formatted = categories.map(c => ({
                id: c.id || c._id.toString(),
                name: c.name,
                description: c.description || '',
                packageCount: pkgCounts[c.id] || 0,
                createdAt: c.createdAt
            }));

            return reply.status(200).send({ categories: formatted });
        } catch (err) {
            console.error('[Admin Package Categories GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGE_CATEGORIES_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const count = await db.collection('package_categories').countDocuments({});
            if (count >= 20) {
                return reply.status(400).send({ error: 'Maximum limit of 20 categories reached.' });
            }

            const { name, description } = req.body || {};
            if (!name || typeof name !== 'string' || !name.trim()) {
                return reply.status(400).send({ error: 'Category name is required.' });
            }

            const newCategory = {
                id: generateCategoryId(),
                name: name.trim(),
                description: String(description || '').trim(),
                createdAt: new Date().toISOString()
            };

            await db.collection('package_categories').insertOne(newCategory);

            return reply.status(201).send({
                success: true,
                message: 'Package category created successfully.',
                category: newCategory
            });
        } catch (err) {
            console.error('[Admin Package Categories POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGE_CATEGORIES_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const { id, name, description } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Category ID is required.' });
            }

            const updateFields = {};
            if (typeof name === 'string' && name.trim()) updateFields.name = name.trim();
            if (typeof description === 'string') updateFields.description = description.trim();

            const result = await db.collection('package_categories').updateOne(
                { id },
                { $set: updateFields }
            );

            if (result.matchedCount === 0) {
                return reply.status(404).send({ error: 'Category not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Category updated successfully.' });
        } catch (err) {
            console.error('[Admin Package Categories PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGE_CATEGORIES_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const { id } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Category ID is required.' });
            }

            const result = await db.collection('package_categories').deleteOne({ id });
            if (result.deletedCount === 0) {
                return reply.status(404).send({ error: 'Category not found.' });
            }

            await db.collection('packages').deleteMany({ categoryId: id });

            return reply.status(200).send({ success: true, message: 'Category and associated packages deleted.' });
        } catch (err) {
            console.error('[Admin Package Categories DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};