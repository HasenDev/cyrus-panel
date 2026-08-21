const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const UploadHelper = require('../../../../lib/UploadHelper');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function generatePackageId() {
    return 'pkg_' + Math.random().toString(36).substring(2, 9);
}

function generatePlanId() {
    return 'plan_' + Math.random().toString(36).substring(2, 9);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGES_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const { package_id, categoryId } = req.query || {};

            if (package_id) {
                const pkg = await db.collection('packages').findOne({ id: package_id });
                if (!pkg) return reply.status(404).send({ error: 'Package not found.' });

                const egg = await db.collection('eggs').findOne({ id: pkg.eggId });
                const nest = await db.collection('nests').findOne({ id: pkg.nestId || (egg ? egg.nestId : null) });
                const allLocations = await db.collection('locations').find({}).toArray();
                const allNests = await db.collection('nests').find({}).toArray();
                const allEggs = await db.collection('eggs').find({}).toArray();

                return reply.status(200).send({
                    package: pkg,
                    eggName: egg ? egg.name : 'Unknown Egg',
                    nestName: nest ? nest.name : 'Unknown Nest',
                    allLocations: allLocations.map(l => ({ id: l.id, name: l.name, flag: l.flag })),
                    allNests: allNests.map(n => ({ id: n.id, name: n.name })),
                    allEggs: allEggs.map(e => ({ id: e.id, nestId: e.nestId, name: e.name }))
                });
            }

            const filter = categoryId ? { categoryId } : {};
            const packages = await db.collection('packages').find(filter).toArray();

            const formatted = packages.map(p => {
                const isConfigured = Array.isArray(p.plans) && p.plans.length > 0 && Array.isArray(p.locations) && p.locations.length > 0;
                return {
                    id: p.id || p._id.toString(),
                    categoryId: p.categoryId,
                    nestId: p.nestId,
                    eggId: p.eggId,
                    name: p.name,
                    description: p.description || '',
                    banner: p.banner || null,
                    icon: p.icon || null,
                    locationsCount: (p.locations || []).length,
                    plansCount: (p.plans || []).length,
                    isConfigured,
                    createdAt: p.createdAt
                };
            });

            return reply.status(200).send({ packages: formatted });
        } catch (err) {
            console.error('[Admin Packages GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGES_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const { categoryId, name, eggId, description } = req.body || {};

            if (!categoryId || !name || !eggId) {
                return reply.status(400).send({ error: 'Category ID, Package Name, and Egg Selection are required.' });
            }

            const category = await db.collection('package_categories').findOne({ id: categoryId });
            if (!category) return reply.status(404).send({ error: 'Category not found.' });

            const pkgCount = await db.collection('packages').countDocuments({ categoryId });
            if (pkgCount >= 20) {
                return reply.status(400).send({ error: 'Maximum limit of 20 packages per category reached.' });
            }

            const egg = await db.collection('eggs').findOne({ id: eggId });
            if (!egg) return reply.status(404).send({ error: 'Selected Egg template not found.' });

            const newPkg = {
                id: generatePackageId(),
                categoryId,
                nestId: egg.nestId,
                eggId: egg.id,
                name: name.trim(),
                description: String(description || '').trim(),
                banner: null,
                icon: null,
                locations: [],
                plans: [],
                createdAt: new Date().toISOString()
            };

            await db.collection('packages').insertOne(newPkg);

            return reply.status(201).send({
                success: true,
                message: 'Package created successfully.',
                package: newPkg
            });
        } catch (err) {
            console.error('[Admin Packages POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGES_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const {
                id,
                name,
                description,
                eggId,
                banner,
                removeBanner,
                icon,
                removeIcon,
                locations,
                plans
            } = req.body || {};

            if (!id) return reply.status(400).send({ error: 'Package ID is required.' });

            const existing = await db.collection('packages').findOne({ id });
            if (!existing) return reply.status(404).send({ error: 'Package not found.' });

            const updates = {};

            if (typeof name === 'string' && name.trim()) updates.name = name.trim();
            if (typeof description === 'string') updates.description = description.trim();

            if (eggId && eggId !== existing.eggId) {
                const egg = await db.collection('eggs').findOne({ id: eggId });
                if (!egg) return reply.status(404).send({ error: 'Selected Egg template not found.' });
                updates.eggId = egg.id;
                updates.nestId = egg.nestId;
            }

            if (removeBanner) {
                updates.banner = null;
            } else if (banner) {
                try {
                    const bannerUrl = await UploadHelper.uploadBase64Stream(banner, 'packages/banners', id, existing.banner);
                    if (bannerUrl) updates.banner = bannerUrl;
                } catch (e) {
                    return reply.status(400).send({ error: 'Banner image upload failed.' });
                }
            }

            if (removeIcon) {
                updates.icon = null;
            } else if (icon) {
                try {
                    const iconUrl = await UploadHelper.uploadBase64Stream(icon, 'packages/icons', id, existing.icon);
                    if (iconUrl) updates.icon = iconUrl;
                } catch (e) {
                    return reply.status(400).send({ error: 'Icon image upload failed.' });
                }
            }

            if (Array.isArray(locations)) {
                updates.locations = locations;
            }

            if (Array.isArray(plans)) {
                updates.plans = plans.map(p => ({
                    id: p.id || generatePlanId(),
                    name: String(p.name || 'Standard Tier').trim(),
                    ramMB: Math.max(128, parseInt(p.ramMB, 10) || 1024),
                    cpuPercent: Math.max(10, parseInt(p.cpuPercent, 10) || 100),
                    diskMB: Math.max(512, parseInt(p.diskMB, 10) || 5000),
                    storageType: ['NVMe', 'SSD', 'HDD'].includes(p.storageType) ? p.storageType : 'NVMe',
                    priceCredits: Math.max(0, parseInt(p.priceCredits, 10) || 0),
                    allocations: Math.min(50, Math.max(1, parseInt(p.allocations, 10) || 1))
                }));
            }

            await db.collection('packages').updateOne({ id }, { $set: updates });

            return reply.status(200).send({ success: true, message: 'Package updated successfully.' });
        } catch (err) {
            console.error('[Admin Packages PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_PACKAGES_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_PACKAGES')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_PACKAGES permission.' });
            }

            const { id } = req.body || {};
            if (!id) return reply.status(400).send({ error: 'Package ID is required.' });

            const result = await db.collection('packages').deleteOne({ id });
            if (result.deletedCount === 0) {
                return reply.status(404).send({ error: 'Package not found.' });
            }

            return reply.status(200).send({ success: true, message: 'Package deleted successfully.' });
        } catch (err) {
            console.error('[Admin Packages DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};