const { getDB } = require('./db');

class NodeManager {
    constructor() {
        this.nodeCache = new Map();
        this.heartbeatInterval = null;
    }
    initMonitor(checkIntervalMs = 30000) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        
        console.log('[NodeManager] Initializing background node health monitor...');
        this.heartbeatInterval = setInterval(() => this.pingAllNodes(), checkIntervalMs);
    }
    async pingAllNodes() {
        try {
            const db = getDB();
            if (!db) return;

            const nodes = await db.collection('nodes').find({}).toArray();

            for (const node of nodes) {
                const status = await this.pingNode(node);
                this.nodeCache.set(node.id, {
                    ...status,
                    lastChecked: new Date()
                });
            }
        } catch (err) {
            console.error('[NodeManager] Error during node health check cycle:', err.message);
        }
    }
    async pingNode(node) {
        const port = node.daemonPort || 8080;
        const scheme = node.scheme || 'https';
        const url = `${scheme}://${node.fqdn}:${port}/test`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${node.daemonKey}`
                },
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const isOnline = res.ok || res.status === 200 || res.status === 401 || res.status === 403;
            
            return {
                isOnline,
                statusCode: res.status,
                fqdn: node.fqdn,
                port
            };
        } catch (err) {
            return {
                isOnline: false,
                error: err.message,
                fqdn: node.fqdn,
                port
            };
        }
    }
    async getNodeStatus(node) {
        if (this.nodeCache.has(node.id)) {
            const cached = this.nodeCache.get(node.id);
            if (Date.now() - new Date(cached.lastChecked).getTime() < 15000) {
                return cached;
            }
        }

        const freshStatus = await this.pingNode(node);
        this.nodeCache.set(node.id, { ...freshStatus, lastChecked: new Date() });
        return freshStatus;
    }
    async getNodeServers(nodeId) {
        const db = getDB();
        return await db.collection('servers').find({ nodeId }).toArray();
    }
}

const nodeManager = new NodeManager();
module.exports = nodeManager;