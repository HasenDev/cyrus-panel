const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { getDB } = require('./db');
const BILLING_CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

function generateTxnId() {
    return 'txn_' + crypto.randomBytes(8).toString('hex');
}

function normalizeUserQuery(userId) {
    if (!userId) return null;
    if (typeof userId === 'string' && ObjectId.isValid(userId)) {
        return { $in: [userId, new ObjectId(userId)] };
    }
    return userId;
}

async function processServerBilling() {
    try {
        const db = getDB();
        if (!db) return;

        const now = new Date();
        const nowMs = now.getTime();

        const pricePer10 = parseFloat(process.env.CREDITS_PRICE_PER_10 || '0.20');
        const pricePerCreditUSD = (pricePer10 > 0 ? pricePer10 : 0.20) / 10;

        const servers = await db.collection('servers').find({}).toArray();

        for (const server of servers) {
            if (server.installing) continue;
            const price = Math.max(0, Number(server.priceCredits) || 0);
            if (price === 0) {
                if (server.suspended) {
                    await db.collection('servers').updateOne(
                        { id: server.id },
                        { $set: { suspended: false, status: 'offline' } }
                    );
                }
                continue;
            }
            const nextPaymentMs = server.nextPaymentDate ? new Date(server.nextPaymentDate).getTime() : 0;

            if (!nextPaymentMs) {
                const createdMs = server.createdAt ? new Date(server.createdAt).getTime() : nowMs;
                await db.collection('servers').updateOne(
                    { id: server.id },
                    {
                        $set: {
                            nextPaymentDate: new Date(createdMs + BILLING_CYCLE_MS).toISOString(),
                            lastPaymentDate: new Date(createdMs).toISOString()
                        }
                    }
                );
                continue;
            }

            if (nowMs >= nextPaymentMs) {
                const userQuery = normalizeUserQuery(server.ownerId);
                const owner = await db.collection('users').findOne({ _id: userQuery });
                if (!owner) continue;

                const rawCredits = owner.credits !== undefined ? owner.credits : (owner.metrics?.credits || 0);
                const userCredits = Math.max(0, Number(rawCredits) || 0);
                const approxUSD = Number((price * pricePerCreditUSD).toFixed(2));
                if (userCredits >= price && price > 0) {
                    const updateResult = await db.collection('users').updateOne(
                        { _id: owner._id, credits: { $gte: price } },
                        {
                            $inc: {
                                credits: -price,
                                'metrics.credits': -price
                            }
                        }
                    );
                    if (updateResult.modifiedCount > 0) {
                        const newNextPayment = new Date(nowMs + BILLING_CYCLE_MS).toISOString();

                        await db.collection('servers').updateOne(
                            { id: server.id },
                            {
                                $set: {
                                    suspended: false,
                                    status: server.suspended ? 'offline' : (server.status || 'offline'),
                                    lastPaymentDate: now.toISOString(),
                                    nextPaymentDate: newNextPayment
                                }
                            }
                        );

                        await db.collection('transactions').insertOne({
                            id: generateTxnId(),
                            userId: owner._id,
                            serverId: server.id,
                            serverName: server.name,
                            credits: -price,
                            amount: price,
                            amountUSD: approxUSD,
                            type: 'renewal',
                            description: `Monthly renewal for server ${server.name} (${server.id})`,
                            status: 'Completed',
                            createdAt: now.toISOString()
                        });
                        continue;
                    }
                }
                if (!server.suspended) {
                    await db.collection('servers').updateOne(
                        { id: server.id },
                        {
                            $set: {
                                suspended: true,
                                status: 'suspended'
                            }
                        }
                    );

                    const node = await db.collection('nodes').findOne({ id: server.nodeId });
                    if (node && !node.maintenanceMode) {
                        try {
                            const scheme = (node.scheme || 'https').replace(/:\/\/*$/, '');
                            const rawFqdn = (node.fqdn || '127.0.0.1').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
                            const port = node.daemonPort || 8080;

                            await fetch(`${scheme}://${rawFqdn}:${port}/api/servers/${server.id}/power`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${node.daemonKey}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ action: 'kill' })
                            }).catch(() => {});
                        } catch {}
                    }

                    await db.collection('transactions').insertOne({
                        id: generateTxnId(),
                        userId: owner._id,
                        serverId: server.id,
                        serverName: server.name,
                        credits: 0,
                        amount: price,
                        amountUSD: approxUSD,
                        type: 'renewal',
                        description: `Failed monthly renewal for server ${server.name} (Insufficient Credits)`,
                        status: 'Failed',
                        createdAt: now.toISOString()
                    });
                }
            }
        }
    } catch (err) {
        console.error('[AutoPayment Cron Error]:', err);
    }
}

function startAutoPaymentCron() {
    setTimeout(processServerBilling, 5000);
    setInterval(processServerBilling, 60000);
}

module.exports = { startAutoPaymentCron, BILLING_CYCLE_MS };
