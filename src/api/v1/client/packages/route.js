const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { checkRateLimit } = require('../../../../lib/rateLimit');
const { validateDockerImage, buildAndValidateEnv } = require('../../../../lib/variableValidator');
const { BILLING_CYCLE_MS } = require('../../../../lib/autoPayment');

function generateServerId() {
    return 'srv_' + crypto.randomBytes(8).toString('hex');
}

function generateTxnId() {
    return 'txn_' + crypto.randomBytes(8).toString('hex');
}

function readEnvMaxDeployments() {
    try {
        const candidates = [
            path.resolve(process.cwd(), '.env'),
            path.resolve(__dirname, '../../../../.env'),
            path.resolve(__dirname, '../../../.env')
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, 'utf8');
                const match = content.match(/^DEFAULT_MAX_DEPLOYMENTS\s*=\s*(.+)$/m);
                if (match) {
                    let val = match[1].trim().replace(/^["']|["']$/g, '');
                    const n = parseInt(val, 10);
                    if (!isNaN(n) && n > 0) return n;
                }
            }
        }
    } catch {}
    return parseInt(process.env.DEFAULT_MAX_DEPLOYMENTS, 10) || 10;
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            if (checkRateLimit(reply, req.userId, 'CLIENT_PACKAGES_GET', 60, 60000)) return;

            const db = getDB();

            const categories = await db.collection('package_categories').find({}).toArray();
            const packages = await db.collection('packages').find({}).toArray();
            const locations = await db.collection('locations').find({}).toArray();
            const eggs = await db.collection('eggs').find({}).toArray();

            const locationMap = {};
            locations.forEach((loc) => {
                locationMap[loc.id] = { id: loc.id, name: loc.name, flag: loc.flag };
            });

            const eggMap = {};
            eggs.forEach((egg) => {
                let dockerImages = {};
                if (egg.docker_images && typeof egg.docker_images === 'object') {
                    dockerImages = egg.docker_images;
                } else if (egg.docker_image) {
                    dockerImages = { Default: egg.docker_image };
                }

                const formattedVariables = (egg.variables || [])
                    .filter((v) => v.user_viewable !== false)
                    .map((v) => ({
                        name: v.name || v.env_variable,
                        description: v.description || '',
                        envVariable: v.env_variable,
                        defaultValue: String(v.default_value || ''),
                        userEditable: Boolean(v.user_editable ?? true),
                        rules: String(v.rules || '')
                    }));

                eggMap[egg.id] = {
                    id: egg.id,
                    name: egg.name,
                    dockerImages,
                    variables: formattedVariables
                };
            });

            const validPackages = packages.filter(
                (p) => Array.isArray(p.plans) && p.plans.length > 0 && Array.isArray(p.locations) && p.locations.length > 0
            );

            const categoryList = categories
                .map((cat) => {
                    const catPackages = validPackages
                        .filter((p) => p.categoryId === cat.id)
                        .map((p) => {
                            const eggInfo = eggMap[p.eggId] || null;
                            return {
                                id: p.id,
                                name: p.name,
                                description: p.description || '',
                                banner: p.banner || null,
                                icon: p.icon || null,
                                eggId: p.eggId,
                                nestId: p.nestId,
                                egg: eggInfo,
                                locations: (p.locations || []).map((locId) => locationMap[locId]).filter(Boolean),
                                plans: (p.plans || []).map((plan) => ({
                                    ...plan,
                                    maxAllocations: Math.min(50, Math.max(0, parseInt(plan.maxAllocations ?? plan.allocations, 10) || 0))
                                }))
                            };
                        });

                    return {
                        id: cat.id,
                        name: cat.name,
                        description: cat.description || '',
                        packages: catPackages
                    };
                })
                .filter((cat) => cat.packages.length > 0);

            return reply.status(200).send({ categories: categoryList });
        } catch (err) {
            console.error('[Client Packages GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error while fetching deployable packages.' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;

            if (checkRateLimit(reply, req.userId, 'CLIENT_PACKAGES_DEPLOY_COOLDOWN', 1, 2000)) return;
            if (checkRateLimit(reply, req.userId, 'CLIENT_PACKAGES_DEPLOY', 15, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            if (!user.emailVerified) {
                return reply.status(403).send({ error: 'Please verify your email address before deploying servers.' });
            }

            const {
                packageId,
                planId,
                locationId,
                serverName,
                serverDescription,
                dockerImage,
                environment = {}
            } = req.body || {};

            if (!packageId || !planId || !locationId || !serverName) {
                return reply.status(400).send({ error: 'Package, Plan, Location, and Server Name are required.' });
            }
            const cleanServerName = String(serverName || '').trim();
            if (cleanServerName.length < 1 || cleanServerName.length > 64) {
                return reply.status(400).send({ error: 'Server name must be between 1 and 64 characters in length.' });
            }
            if (!/^[a-zA-Z0-9_\-\.\s]+$/.test(cleanServerName)) {
                return reply.status(400).send({
                    error: 'Server name may only contain letters, numbers, spaces, underscores, periods, and dashes.'
                });
            }
            const cleanDescription = String(serverDescription || '').trim();
            if (cleanDescription.length > 255) {
                return reply.status(400).send({ error: 'Server description cannot exceed 255 characters.' });
            }
            const envDefaultMax = readEnvMaxDeployments();
            const userMaxDeployments = user.maxDeployments !== undefined && user.maxDeployments !== null
                ? parseInt(user.maxDeployments, 10)
                : envDefaultMax;

            const currentDeployments = await db.collection('servers').countDocuments({
                $or: [
                    { ownerId: user._id },
                    { ownerId: String(user._id) }
                ]
            });

            if (currentDeployments >= userMaxDeployments) {
                return reply.status(400).send({
                    error: `Deployment limit reached. You currently have ${currentDeployments} / ${userMaxDeployments} active servers deployed.`
                });
            }
            const pkg = await db.collection('packages').findOne({ id: packageId });
            if (!pkg) return reply.status(404).send({ error: 'Selected Package not found.' });

            const plan = (pkg.plans || []).find((p) => p.id === planId);
            if (!plan) return reply.status(404).send({ error: 'Selected Plan tier not found.' });

            if (!pkg.locations.includes(locationId)) {
                return reply.status(400).send({ error: 'Selected location is not enabled for this package.' });
            }
            const userCredits = typeof user.credits === 'number' ? user.credits : 0;
            if (userCredits < plan.priceCredits) {
                return reply.status(400).send({
                    error: `Insufficient credits. Required: ${plan.priceCredits} Cr, Available: ${userCredits} Cr.`
                });
            }
            const nodesInLoc = await db.collection('nodes').find({ locationId, maintenanceMode: false }).toArray();
            if (nodesInLoc.length === 0) {
                return reply.status(400).send({ error: 'No active nodes available in the selected location.' });
            }

            const nodeIds = nodesInLoc.map((n) => n.id);
            const allocation = await db.collection('allocations').findOne({
                nodeId: { $in: nodeIds },
                assignedServerId: null
            });

            if (!allocation) {
                return reply.status(400).send({ error: 'No free port allocations currently available in this location.' });
            }

            const assignedNode = nodesInLoc.find((n) => n.id === allocation.nodeId);
            if (!assignedNode) {
                return reply.status(400).send({ error: 'Node allocation lookup error.' });
            }

            const egg = await db.collection('eggs').findOne({ id: pkg.eggId });
            if (!egg) return reply.status(404).send({ error: 'Package runtime egg configuration not found.' });
            const imageCandidate = dockerImage || Object.values(egg.docker_images || {})[0] || egg.docker_image || 'ubuntu:latest';
            const imgValidation = validateDockerImage(egg, imageCandidate);
            if (!imgValidation.valid) {
                return reply.status(400).send({ error: imgValidation.error });
            }
            const selectedImage = imgValidation.image;
            if (typeof environment !== 'object' || Array.isArray(environment) || environment === null) {
                return reply.status(400).send({ error: 'Environment variables payload must be an object.' });
            }

            const envValidation = buildAndValidateEnv(egg.variables, environment, true);
            if (!envValidation.valid) {
                return reply.status(422).send({
                    error: envValidation.error,
                    variable: envValidation.variable
                });
            }
            const finalEnv = envValidation.env;

            const serverId = generateServerId();
            const maxAllocationsVal = Math.min(50, Math.max(0, parseInt(plan.maxAllocations ?? plan.allocations, 10) || 0));
            const now = new Date();
            const nextPayDate = new Date(now.getTime() + (BILLING_CYCLE_MS || 300000)).toISOString();

            const serverPayload = {
                id: serverId,
                name: cleanServerName,
                description: cleanDescription,
                ownerId: user._id,
                ownerUsername: user.username,
                nodeId: assignedNode.id,
                allocationId: allocation.id,
                additionalAllocationIds: [],
                nestId: pkg.nestId,
                eggId: pkg.eggId,
                packageId: pkg.id,
                packageName: pkg.name,
                planId: plan.id,
                planName: plan.name || 'Custom Plan',
                dockerImage: selectedImage,
                startup: egg.startup || '',
                env: finalEnv,
                memory: plan.ramMB,
                disk: plan.diskMB,
                cpu: plan.cpuPercent,
                priceCredits: plan.priceCredits,
                maxAllocations: maxAllocationsVal,
                installing: true,
                status: 'installing',
                suspended: false,
                lastPaymentDate: now.toISOString(),
                nextPaymentDate: nextPayDate,
                eggScript: egg.scripts || {},
                allocations: {
                    primary: { ip: allocation.ip, port: allocation.port },
                    additional: []
                },
                createdAt: now.toISOString()
            };
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);

                const daemonRes = await fetch(`https://${assignedNode.fqdn}:${assignedNode.daemonPort || 8080}/api/servers`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${assignedNode.daemonKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(serverPayload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const daemonData = await daemonRes.json();
                if (!daemonRes.ok || !daemonData.success) {
                    return reply.status(400).send({
                        error: `Node Daemon Error: ${daemonData.error || 'Failed to initialize container on node.'}`
                    });
                }
            } catch {
                return reply.status(502).send({
                    error: `Node Daemon Unreachable (${assignedNode.name}). Please try again later.`
                });
            }
            await db.collection('users').updateOne(
                { _id: user._id },
                {
                    $inc: {
                        credits: -plan.priceCredits
                    }
                }
            );
            await db.collection('transactions').insertOne({
                id: generateTxnId(),
                serverId,
                serverName: cleanServerName,
                userId: user._id,
                amount: plan.priceCredits,
                type: 'deployment',
                status: 'paid',
                createdAt: now.toISOString()
            });

            await db.collection('servers').insertOne(serverPayload);

            await db.collection('allocations').updateOne(
                { id: allocation.id },
                { $set: { assignedServerId: serverId, assignedServerName: serverPayload.name } }
            );

            return reply.status(201).send({
                success: true,
                message: 'Server deployed successfully!',
                serverId
            });
        } catch (err) {
            console.error('[Client Package Deploy POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error while deploying server.' });
        }
    }
};
