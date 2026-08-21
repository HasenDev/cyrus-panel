const hitsMap = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hitsMap.entries()) {
        if (now > record.resetTime) {
            hitsMap.delete(key);
        }
    }
}, 120 * 1000);
function checkRateLimit(reply, userId, actionKey, maxLimit = 40, windowMs = 60000) {
    if (!userId) return false;

    const key = `${actionKey}:${userId}`;
    const now = Date.now();

    let record = hitsMap.get(key);

    if (!record || now > record.resetTime) {
        record = {
            count: 1,
            resetTime: now + windowMs
        };
        hitsMap.set(key, record);
        return false;
    }

    record.count += 1;

    if (record.count > maxLimit) {
        const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);
        reply.header('Retry-After', retryAfterSeconds);
        reply.status(429).send({
            error: `Too many requests. Rate limit exceeded (${maxLimit} requests per ${Math.round(windowMs / 1000)}s). Please try again in ${retryAfterSeconds} seconds.`,
            retryAfter: retryAfterSeconds
        });
        return true;
    }

    return false;
}

module.exports = { checkRateLimit };