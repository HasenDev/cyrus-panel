const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CLOUDFLARE_IPV4_FALLBACK = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22'
];

const CLOUDFLARE_IPV6_FALLBACK = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

const DOCKER_AND_CYRUS_CIDRS = [
  '172.19.0.1/32',
  '172.16.0.0/12'
];

const TRUSTED_LOCAL_CIDRS = [
  '127.0.0.0/8',
  '::1/128'
];

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'cfIPs.json');
const CACHE_TTL_MS = 30 * 60 * 1000;

function isValidCidr(cidr, expectedVersion) {
  if (!cidr || typeof cidr !== 'string') return false;
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;

  const [range, prefixStr] = parts;
  const version = net.isIP(range);
  if (version === 0 || (expectedVersion && version !== expectedVersion)) return false;

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || String(prefix) !== prefixStr) return false;

  if (version === 4 && (prefix < 0 || prefix > 32)) return false;
  if (version === 6 && (prefix < 0 || prefix > 128)) return false;

  return true;
}

let activeIpv4Cidrs = CLOUDFLARE_IPV4_FALLBACK.filter((cidr) => isValidCidr(cidr, 4));
let activeIpv6Cidrs = CLOUDFLARE_IPV6_FALLBACK.filter((cidr) => isValidCidr(cidr, 6));
let cachedEtag = null;
let lastFetchedAt = 0;
let isFetching = false;

function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  let cleaned = ip.trim();
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.substring(7);
  }
  return cleaned;
}

function ipv4ToBigInt(ip) {
  const octets = ip.split('.').map(Number);
  return BigInt(
    ((octets[0] << 24) >>> 0) +
    ((octets[1] << 16) >>> 0) +
    ((octets[2] << 8) >>> 0) +
    (octets[3] >>> 0)
  );
}

function ipv6ToBigInt(ip) {
  let fullIp = ip;
  if (fullIp.includes('::')) {
    const parts = fullIp.split('::');
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (head.length + tail.length);
    const middle = new Array(missing).fill('0');
    fullIp = [...head, ...middle, ...tail].join(':');
  }

  const sections = fullIp.split(':').map((hex) => parseInt(hex || '0', 16));
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result = (result << 16n) | BigInt(sections[i] || 0);
  }
  return result;
}

function isIpInCidr(ip, cidr) {
  try {
    if (!isValidCidr(cidr)) return false;

    const [range, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const version = net.isIP(ip);

    if (version !== net.isIP(range)) return false;

    if (version === 4) {
      const ipInt = ipv4ToBigInt(ip);
      const rangeInt = ipv4ToBigInt(range);
      const mask = prefix === 0 ? 0n : ((~0n << BigInt(32 - prefix)) & 0xffffffffn);
      return (ipInt & mask) === (rangeInt & mask);
    }

    if (version === 6) {
      const ipInt = ipv6ToBigInt(ip);
      const rangeInt = ipv6ToBigInt(range);
      const mask = prefix === 0 ? 0n : ((~0n << BigInt(128 - prefix)) & ((1n << 128n) - 1n));
      return (ipInt & mask) === (rangeInt & mask);
    }
  } catch {
    return false;
  }
  return false;
}

function isDockerOrCyrusIp(ip) {
  return DOCKER_AND_CYRUS_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

function isCloudflareIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    return activeIpv4Cidrs.some((cidr) => isIpInCidr(ip, cidr));
  } else if (version === 6) {
    return activeIpv6Cidrs.some((cidr) => isIpInCidr(ip, cidr));
  }
  return false;
}

function isTrustedLocalProxy(ip) {
  if (isDockerOrCyrusIp(ip)) {
    return false;
  }
  return TRUSTED_LOCAL_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

function atomicWriteFileSync(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

function fetchOfficialCloudflareIps(etag = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'NodeJS-IP-Resolver',
      'Accept': 'application/json'
    };

    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const request = https.get('https://api.cloudflare.com/client/v4/ips', {
      headers,
      timeout: 10000
    }, (res) => {
      if (res.statusCode === 304) {
        res.resume();
        return resolve({ notModified: true });
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Failed Cloudflare API request with status ${res.statusCode}`));
      }

      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          if (parsed.success && parsed.result) {
            const rawV4 = Array.isArray(parsed.result.ipv4_cidrs) ? parsed.result.ipv4_cidrs : [];
            const rawV6 = Array.isArray(parsed.result.ipv6_cidrs) ? parsed.result.ipv6_cidrs : [];

            const validV4 = rawV4.filter((cidr) => isValidCidr(cidr, 4));
            const validV6 = rawV6.filter((cidr) => isValidCidr(cidr, 6));

            if (validV4.length === 0 || validV6.length === 0) {
              return reject(new Error('Cloudflare API returned empty or invalid CIDR lists'));
            }

            const newEtag = res.headers.etag || (typeof parsed.result.etag === 'string' ? parsed.result.etag : null);

            resolve({
              notModified: false,
              etag: newEtag,
              ipv4_cidrs: validV4,
              ipv6_cidrs: validV6
            });
          } else {
            reject(new Error('Invalid Cloudflare API payload structure'));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Cloudflare API timeout'));
    });
  });
}

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data && Array.isArray(data.ipv4_cidrs) && Array.isArray(data.ipv6_cidrs)) {
        const rawV4 = data.ipv4_cidrs;
        const rawV6 = data.ipv6_cidrs;

        const validV4 = rawV4.filter((cidr) => isValidCidr(cidr, 4));
        const validV6 = rawV6.filter((cidr) => isValidCidr(cidr, 6));

        if (validV4.length > 0 && validV6.length > 0) {
          activeIpv4Cidrs = validV4;
          activeIpv6Cidrs = validV6;
          cachedEtag = typeof data.etag === 'string' ? data.etag : null;
          lastFetchedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
        }
      }
    }
  } catch {}
}

async function refreshCloudflareIps(force = false) {
  if (isFetching) return;
  const now = Date.now();
  if (!force && lastFetchedAt && (now - lastFetchedAt < CACHE_TTL_MS)) {
    return;
  }

  isFetching = true;
  try {
    const result = await fetchOfficialCloudflareIps(cachedEtag);

    if (result.notModified) {
      lastFetchedAt = now;
      atomicWriteFileSync(CACHE_FILE, JSON.stringify({
        updatedAt: now,
        etag: cachedEtag,
        ipv4_cidrs: activeIpv4Cidrs,
        ipv6_cidrs: activeIpv6Cidrs
      }, null, 2));
      return;
    }

    if (result.ipv4_cidrs.length > 0 && result.ipv6_cidrs.length > 0) {
      activeIpv4Cidrs = result.ipv4_cidrs;
      activeIpv6Cidrs = result.ipv6_cidrs;
      cachedEtag = result.etag || null;
      lastFetchedAt = now;

      atomicWriteFileSync(CACHE_FILE, JSON.stringify({
        updatedAt: now,
        etag: cachedEtag,
        ipv4_cidrs: activeIpv4Cidrs,
        ipv6_cidrs: activeIpv6Cidrs
      }, null, 2));
    }
  } catch {} finally {
    isFetching = false;
  }
}

loadCacheFromDisk();

if (!lastFetchedAt || (Date.now() - lastFetchedAt >= CACHE_TTL_MS)) {
  refreshCloudflareIps(true).catch(() => {});
}

setInterval(() => {
  refreshCloudflareIps(false).catch(() => {});
}, CACHE_TTL_MS).unref();

function getClientIp(req) {
  if (!req) return '127.0.0.1';

  if (!lastFetchedAt || (Date.now() - lastFetchedAt >= CACHE_TTL_MS)) {
    refreshCloudflareIps(false).catch(() => {});
  }

  const peerIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
  const headers = req.headers || {};

  if (isCloudflareIp(peerIp)) {
    const cfIp = normalizeIp(headers['cf-connecting-ip']);
    if (cfIp && net.isIP(cfIp) && !isDockerOrCyrusIp(cfIp)) {
      return cfIp;
    }
  }

  if (isTrustedLocalProxy(peerIp)) {
    const cfIp = normalizeIp(headers['cf-connecting-ip']);
    if (cfIp && net.isIP(cfIp) && !isDockerOrCyrusIp(cfIp)) {
      return cfIp;
    }

    const xForwardedFor = headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      const clientCandidate = normalizeIp(xForwardedFor.split(',')[0].trim());
      if (net.isIP(clientCandidate) && !isDockerOrCyrusIp(clientCandidate)) {
        return clientCandidate;
      }
    }

    const xRealIp = normalizeIp(headers['x-real-ip']);
    if (xRealIp && net.isIP(xRealIp) && !isDockerOrCyrusIp(xRealIp)) {
      return xRealIp;
    }
  }

  if (peerIp && net.isIP(peerIp)) {
    return peerIp;
  }

  const reqIp = normalizeIp(req.ip);
  return net.isIP(reqIp) ? reqIp : '127.0.0.1';
}

module.exports = {
  getClientIp,
  isCloudflareIp,
  isTrustedLocalProxy,
  isDockerOrCyrusIp,
  isValidCidr,
  refreshCloudflareIps,
  normalizeIp
};