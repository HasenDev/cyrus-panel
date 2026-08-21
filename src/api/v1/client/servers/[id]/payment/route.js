const { getDB } = require('../../../../../../lib/db');
const { authenticate } = require('../../../../../../lib/auth');
const { checkRateLimit } = require('../../../../../../lib/rateLimit');
const { getUserServerPermissions } = require('../../../../../../lib/serverPermissions');
const { BILLING_CYCLE_MS } = require('../../../../../../lib/autoPayment');
const { logActivity } = require('../../../../../../lib/logActivity');

function generateTxnId() {
  return 'txn_' + Math.random().toString(36).substring(2, 10);
}

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

      if (checkRateLimit(reply, req.userId, 'CLIENT_PAYMENT_GET', 60, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('payment.view')) {
        return reply.status(403).send({ error: 'Access denied: Requires payment.view permission.' });
      }

      const user = await db.collection('users').findOne({ _id: req.userId });

      const userCredits = typeof user?.credits === 'number' ? Math.max(0, user.credits) : 0;

      const priceCredits = Math.max(0, Number(server.priceCredits) || 0);
      const isLifetime = priceCredits === 0;

      const canAffordCount = (!isLifetime && priceCredits > 0)
        ? Math.max(0, Math.floor(userCredits / priceCredits))
        : 0;

      const nextPaymentDate = server.nextPaymentDate || new Date(Date.now() + (BILLING_CYCLE_MS || 2592000000)).toISOString();
      const timeLeftMs = isLifetime ? 0 : Math.max(0, new Date(nextPaymentDate).getTime() - Date.now());

      let availablePlans = [];
      let packageName = server.packageName || 'Custom Package';
      let planName = server.planName || 'Custom Tier';

      if (server.packageId) {
        const pkg = await db.collection('packages').findOne({ id: server.packageId });
        if (pkg && Array.isArray(pkg.plans) && pkg.plans.length > 0) {
          packageName = pkg.name || packageName;
          const matchedPlan = pkg.plans.find((p) => p.id === server.planId);
          if (matchedPlan) {
            planName = matchedPlan.name || planName;
          }

          availablePlans = pkg.plans.map((p) => ({
            id: p.id,
            name: p.name,
            ramMB: p.ramMB,
            cpuPercent: p.cpuPercent,
            diskMB: p.diskMB,
            priceCredits: Math.max(0, Number(p.priceCredits) || 0),
            maxAllocations: Math.min(50, Math.max(0, parseInt(p.maxAllocations ?? p.allocations, 10) || 0))
          }));
        } else {
          packageName = 'Custom Package';
          planName = 'Custom Tier';
        }
      }

      const transactions = await db.collection('transactions')
        .find({ serverId: server.id })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();

      return reply.status(200).send({
        packageId: server.packageId || null,
        packageName,
        planId: server.planId || null,
        planName,
        priceCredits,
        isLifetime,
        userCredits,
        canAffordCount,
        nextPaymentDate,
        timeLeftMs,
        suspended: Boolean(server.suspended),
        installing: Boolean(server.installing),
        billingCycleMs: BILLING_CYCLE_MS || 2592000000,
        availablePlans,
        canManage: isOwner || permissions.includes('payment.manage'),
        transactions: transactions.map((t) => ({
          id: t.id || t._id.toString(),
          amount: t.amount,
          type: t.type || 'renewal',
          description: t.description || '',
          status: t.status || 'paid',
          createdAt: t.createdAt
        }))
      });
    } catch (err) {
      console.error('[Client Payment GET Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while loading payment details.' });
    }
  },

  POST: async (req, reply) => {
    try {
      await authenticate(req, reply);
      if (reply.sent) return;

      if (checkRateLimit(reply, req.userId, 'CLIENT_PAYMENT_POST', 15, 60000)) return;

      const db = getDB();
      const serverId = extractServerId(req);
      if (!serverId) return reply.status(400).send({ error: 'Server ID is required.' });

      const server = await db.collection('servers').findOne({ id: serverId });
      if (!server) return reply.status(404).send({ error: 'Server not found or access denied.' });

      const { isOwner, permissions } = await getUserServerPermissions(req.userId, server, db);
      if (!isOwner && !permissions.includes('payment.manage')) {
        return reply.status(403).send({ error: 'Access denied: Requires payment.manage permission.' });
      }

      if (server.installing) {
        return reply.status(400).send({ error: 'Payment actions are disabled while server is installing.' });
      }

      const user = await db.collection('users').findOne({ _id: req.userId });
      const userCredits = typeof user?.credits === 'number' ? Math.max(0, user.credits) : 0;

      const { action, newPlanId } = req.body || {};

      const pricePer10 = parseFloat(process.env.CREDITS_PRICE_PER_10 || '0.20');
      const pricePerCreditUSD = (pricePer10 > 0 ? pricePer10 : 0.20) / 10;

      if (action === 'change_plan') {
        if (!newPlanId) return reply.status(400).send({ error: 'New plan ID is required.' });
        if (!server.packageId) return reply.status(400).send({ error: 'Cannot switch plan: server is not linked to an existing package template.' });

        const pkg = await db.collection('packages').findOne({ id: server.packageId });
        if (!pkg || !Array.isArray(pkg.plans)) {
          return reply.status(404).send({ error: 'Associated package template no longer exists.' });
        }

        const targetPlan = pkg.plans.find((p) => p.id === newPlanId);
        if (!targetPlan) return reply.status(404).send({ error: 'Selected plan tier was not found in package.' });

        if (server.planId === targetPlan.id) {
          return reply.status(400).send({ error: 'Server is already running on this plan tier.' });
        }

        const targetPrice = Math.max(0, Number(targetPlan.priceCredits) || 0);

        if (targetPrice > 0 && userCredits < targetPrice) {
          return reply.status(400).send({
            error: `Insufficient credits. Required: ${targetPrice} Credits, Available: ${userCredits} Credits.`
          });
        }

        const now = new Date();
        const nextPayDate = new Date(now.getTime() + (BILLING_CYCLE_MS || 2592000000)).toISOString();
        const approxUSD = Number((targetPrice * pricePerCreditUSD).toFixed(2));

        if (targetPrice > 0) {
          const deductResult = await db.collection('users').updateOne(
            { _id: user._id, credits: { $gte: targetPrice } },
            {
              $inc: {
                credits: -targetPrice
              }
            }
          );

          if (deductResult.modifiedCount === 0) {
            return reply.status(400).send({ error: 'Insufficient credits to switch plan.' });
          }
        }

        const maxAllocationsVal = Math.min(50, Math.max(0, parseInt(targetPlan.maxAllocations ?? targetPlan.allocations, 10) || 0));
        let currentAdditional = Array.isArray(server.additionalAllocationIds) ? [...server.additionalAllocationIds] : [];
        const allowedAdditional = Math.max(0, maxAllocationsVal - 1);

        if (currentAdditional.length > allowedAdditional) {
          const keepAdditional = currentAdditional.slice(0, allowedAdditional);
          const removeAdditional = currentAdditional.slice(allowedAdditional);

          if (removeAdditional.length > 0) {
            await db.collection('allocations').updateMany(
              { id: { $in: removeAdditional } },
              {
                $set: {
                  assignedServerId: null,
                  assignedServerName: null,
                  notes: ''
                }
              }
            );
          }

          currentAdditional = keepAdditional;
        }

        const updateDoc = {
          planId: targetPlan.id,
          planName: targetPlan.name || 'Custom Plan',
          memory: targetPlan.ramMB,
          disk: targetPlan.diskMB,
          cpu: targetPlan.cpuPercent,
          priceCredits: targetPrice,
          maxAllocations: maxAllocationsVal,
          additionalAllocationIds: currentAdditional,
          suspended: false,
          lastPaymentDate: now.toISOString(),
          nextPaymentDate: nextPayDate
        };

        if (server.suspended) {
          updateDoc.status = 'offline';
        }

        await db.collection('servers').updateOne({ id: server.id }, { $set: updateDoc });

        if (targetPrice > 0) {
          await db.collection('transactions').insertOne({
            id: generateTxnId(),
            userId: user._id,
            serverId: server.id,
            serverName: server.name,
            credits: -targetPrice,
            amount: targetPrice,
            amountUSD: approxUSD,
            type: 'plan_change',
            description: `Switched plan tier to ${targetPlan.name} on server ${server.name}`,
            status: 'Completed',
            createdAt: now.toISOString()
          });
        }

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:payment.change_plan',
          detail: `Upgraded server resource tier to ${targetPlan.name} (${targetPrice} Credits/mo)`,
          metadata: { newPlanId, planName: targetPlan.name, priceCredits: targetPrice }
        });

        return reply.status(200).send({
          success: true,
          message: `Plan successfully switched to ${targetPlan.name}! Please restart your server to apply new resource limits.`
        });
      }

      if (action === 'reactivate' || (!action && server.suspended)) {
        if (!server.suspended) {
          return reply.status(400).send({ error: 'This server is currently active.' });
        }

        const price = Math.max(0, Number(server.priceCredits) || 0);

        if (price > 0 && userCredits < price) {
          return reply.status(400).send({
            error: `Insufficient credits. You need ${price} Credits to reactivate this server.`
          });
        }

        const now = new Date();
        const newNextPayment = new Date(now.getTime() + (BILLING_CYCLE_MS || 2592000000)).toISOString();
        const approxUSD = Number((price * pricePerCreditUSD).toFixed(2));

        if (price > 0) {
          const deductResult = await db.collection('users').updateOne(
            { _id: user._id, credits: { $gte: price } },
            {
              $inc: {
                credits: -price
              }
            }
          );

          if (deductResult.modifiedCount === 0) {
            return reply.status(400).send({ error: 'Insufficient credits to reactivate server.' });
          }
        }

        await db.collection('servers').updateOne(
          { id: server.id },
          {
            $set: {
              suspended: false,
              status: 'offline',
              lastPaymentDate: now.toISOString(),
              nextPaymentDate: newNextPayment
            }
          }
        );

        if (price > 0) {
          await db.collection('transactions').insertOne({
            id: generateTxnId(),
            userId: user._id,
            serverId: server.id,
            serverName: server.name,
            credits: -price,
            amount: price,
            amountUSD: approxUSD,
            type: 'reactivation',
            description: `Reactivated server ${server.name} (${server.id})`,
            status: 'Completed',
            createdAt: now.toISOString()
          });
        }

        logActivity(req, db, {
          serverId: server.id,
          action: 'server:payment.reactivate',
          detail: `Paid renewal fees (${price} Credits) and unsuspended server instance`,
          metadata: { priceCredits: price }
        });

        return reply.status(200).send({
          success: true,
          message: 'Server unsuspended and renewed successfully!'
        });
      }

      return reply.status(400).send({ error: 'Invalid payment action provided.' });
    } catch (err) {
      console.error('[Client Payment POST Error]:', err);
      return reply.status(500).send({ error: 'Internal server error while processing payment.' });
    }
  }
};