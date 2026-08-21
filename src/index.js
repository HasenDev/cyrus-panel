const path = require('path');
const fs = require('fs');
const os = require('os');
const dotenv = require('dotenv');
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const chalk = require('chalk');
const figlet = require('figlet');
const sharp = require('sharp');
const fastify = require('fastify')({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024 * 1024
});
const { checkAndRunSetup } = require('./lib/setupPanel');

const uploadDir = path.join(__dirname, '../uploads');
const cacheDir = path.join(__dirname, '../cache');

const frontendDir = fs.existsSync(path.join(__dirname, 'frontend'))
    ? path.join(__dirname, 'frontend')
    : fs.existsSync(path.join(__dirname, '../frontend'))
    ? path.join(__dirname, '../frontend')
    : path.resolve(process.cwd(), 'frontend');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tiff']);

const applyCyanGradient = (text) => {
    const lines = text.split('\n');
    const startColor = [0, 242, 254];
    const endColor = [79, 172, 254];

    return lines.map((line) => {
        if (!line) return line;
        const chars = line.split('');
        const total = chars.length || 1;
        return chars.map((char, index) => {
            const ratio = index / total;
            const r = Math.round(startColor[0] + (endColor[0] - startColor[0]) * ratio);
            const g = Math.round(startColor[1] + (endColor[1] - startColor[1]) * ratio);
            const b = Math.round(startColor[2] + (endColor[2] - startColor[2]) * ratio);
            return chalk.rgb(r, g, b)(char);
        }).join('');
    }).join('\n');
};

const getAccessibleUrls = (port, host) => {
    const urls = [];

    if (host && host !== '0.0.0.0' && host !== '::' && host !== '0:0:0:0:0:0:0:0') {
        urls.push(`http://${host}:${port}`);
        return urls;
    }

    urls.push(`http://localhost:${port}`);

    const interfaces = os.networkInterfaces();
    for (const devName of Object.keys(interfaces)) {
        const ifaceList = interfaces[devName];
        if (!ifaceList) continue;

        for (const iface of ifaceList) {
            if (iface.family === 'IPv4' && !iface.internal) {
                urls.push(`http://${iface.address}:${port}`);
            }
        }
    }

    return Array.from(new Set(urls));
};

const normalizeQueryValue = (value) => {
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === 'string' && item.trim() !== '') return item.trim();
        }
        return undefined;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? undefined : trimmed;
    }
    return undefined;
};

const safeRelativePath = (input) => {
    if (typeof input !== 'string' || input.trim() === '') return null;

    const normalized = path.posix
        .normalize(input.replace(/\\/g, '/'))
        .replace(/^\/+/, '');

    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
        return null;
    }

    return normalized;
};

const parseSize = (value) => {
    if (!value) return { width: null, height: null, valid: true };

    const raw = String(value).trim().toLowerCase();
    const MAX_DIMENSION = 4096;

    if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0 || n > MAX_DIMENSION) {
            return { width: null, height: null, valid: false };
        }
        return { width: n, height: n, valid: true };
    }

    const match = raw.match(/^(\d*)x(\d*)$/);
    if (!match) return { width: null, height: null, valid: false };

    const w = match[1] ? parseInt(match[1], 10) : null;
    const h = match[2] ? parseInt(match[2], 10) : null;

    if (
        (w !== null && (!Number.isFinite(w) || w <= 0 || w > MAX_DIMENSION)) ||
        (h !== null && (!Number.isFinite(h) || h <= 0 || h > MAX_DIMENSION)) ||
        (w === null && h === null)
    ) {
        return { width: null, height: null, valid: false };
    }

    return { width: w, height: h, valid: true };
};

const normalizeTargetType = (value) => {
    if (!value) return null;
    let type = String(value).trim().toLowerCase();

    if (type === 'wbep') type = 'webp';
    if (type === 'jpg' || type === 'jpe') type = 'jpeg';
    if (type === 'tif') type = 'tiff';

    if (!['png', 'jpeg', 'webp', 'avif', 'gif', 'tiff'].includes(type)) {
        return null;
    }

    return type;
};

const removeIfExists = async (filePath) => {
    try {
        await fs.promises.unlink(filePath);
    } catch {}
};

const resolveOriginalFile = (filePath) => {
    const safePath = safeRelativePath(filePath);
    if (!safePath) return null;

    const dirName = path.posix.dirname(safePath);
    const filename = path.posix.basename(safePath);
    const ext = path.posix.extname(filename).toLowerCase();
    const baseName = path.posix.basename(filename, ext);

    const currentUploadDir = dirName === '.' ? uploadDir : path.join(uploadDir, dirName);

    let originalFilePath = path.join(currentUploadDir, filename);
    let actualExt = ext;
    let actualFilename = filename;
    let fileExists = fs.existsSync(originalFilePath);

    if (!fileExists && fs.existsSync(currentUploadDir)) {
        const files = fs.readdirSync(currentUploadDir);
        const matchedFile = files.find((f) => {
            const candidateExt = path.extname(f).toLowerCase();
            const candidateBase = path.basename(f, candidateExt);
            return candidateBase === baseName && imageExts.has(candidateExt);
        });

        if (matchedFile) {
            originalFilePath = path.join(currentUploadDir, matchedFile);
            actualExt = path.extname(matchedFile).toLowerCase();
            actualFilename = matchedFile;
            fileExists = true;
        }
    }

    if (!fileExists) return null;

    return {
        dirName,
        filename,
        ext,
        baseName,
        currentUploadDir,
        originalFilePath,
        actualExt,
        actualFilename
    };
};

const getMimeType = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.txt': 'text/plain; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.wasm': 'application/wasm',
        '.map': 'application/json; charset=utf-8',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm'
    };
    return map[ext] || 'application/octet-stream';
};

const applyHtmlHeaders = (reply) => {
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header(
        'Content-Security-Policy',
        [
            "default-src 'self' https: http:;",
            "img-src 'self' https: http: data: blob:;",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:;",
            "style-src 'self' 'unsafe-inline' https: http:;",
            "font-src 'self' https: http: data:;",
            "connect-src 'self' https: http: wss: ws:;",
            "frame-src 'self' https: http: https://www.google.com https://recaptcha.net;",
            "media-src 'self' https: http:;",
            "object-src 'none';",
            "base-uri 'self';",
            "form-action 'self' https: http:;",
            "frame-ancestors 'self' https: http:;"
        ].join(' ')
    );
    reply.header('X-Robots-Tag', 'index, follow, all');
};

const handleFrontendRouting = async (req, reply) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(parsedUrl.pathname);

    if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/cdn/') || pathname === '/cdn') {
        return reply.code(404).send({ error: 'Endpoint not found' });
    }

    if (!fs.existsSync(frontendDir)) {
        return reply.code(404).send('Frontend build not found.');
    }

    const safePath = safeRelativePath(pathname) || '';

    let targetFilePath = null;
    let isHtml = false;

    const candidateDirect = path.join(frontendDir, safePath);
    const candidateHtml = path.join(frontendDir, `${safePath}.html`);
    const candidateIndex = path.join(frontendDir, safePath, 'index.html');

    if (safePath === '' || safePath === '/') {
        const rootIndex = path.join(frontendDir, 'index.html');
        if (fs.existsSync(rootIndex)) {
            targetFilePath = rootIndex;
            isHtml = true;
        }
    } else if (fs.existsSync(candidateDirect) && fs.statSync(candidateDirect).isFile()) {
        targetFilePath = candidateDirect;
        isHtml = candidateDirect.endsWith('.html');
    } else if (fs.existsSync(candidateHtml) && fs.statSync(candidateHtml).isFile()) {
        targetFilePath = candidateHtml;
        isHtml = true;
    } else if (fs.existsSync(candidateIndex) && fs.statSync(candidateIndex).isFile()) {
        targetFilePath = candidateIndex;
        isHtml = true;
    }

    if (targetFilePath) {
        reply.type(getMimeType(targetFilePath));

        if (isHtml) {
            applyHtmlHeaders(reply);
        } else if (pathname.startsWith('/_next/static/')) {
            reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }

        return reply.send(fs.createReadStream(targetFilePath));
    }

    const notFoundHtml = path.join(frontendDir, '404.html');
    if (fs.existsSync(notFoundHtml)) {
        reply.code(404).type('text/html; charset=utf-8');
        applyHtmlHeaders(reply);
        return reply.send(fs.createReadStream(notFoundHtml));
    }

    const fallbackIndex = path.join(frontendDir, 'index.html');
    if (fs.existsSync(fallbackIndex)) {
        reply.code(200).type('text/html; charset=utf-8');
        applyHtmlHeaders(reply);
        return reply.send(fs.createReadStream(fallbackIndex));
    }

    return reply.code(404).send('Not Found');
};

function displayStartupDashboard(port, host, routeCount) {
    console.clear();

    const bannerRaw = figlet.textSync('Cyrus Panel', {
        font: 'Standard',
        horizontalLayout: 'default'
    });

    const bannerGradient = applyCyanGradient(bannerRaw);

    const rawEnv = (process.env.NODE_ENV || 'production').trim().toLowerCase();
    const isDev = rawEnv === 'development' || rawEnv === 'dev';
    const envBadge = isDev
        ? chalk.bgBlue.white.bold(' Development ')
        : chalk.bgGreen.white.bold(' Production ');

    const urls = getAccessibleUrls(port, host);

    console.log(bannerGradient);
    console.log(chalk.gray('─────────────────────────────────────────────────────────────'));
    console.log(` ${chalk.bold('Database')}       : ${chalk.green('Connected')}`);
    console.log(` ${chalk.bold('API Endpoints')}  : ${chalk.green(`${routeCount} routes loaded`)}`);
    console.log(` ${chalk.bold('Billing Cron')}   : ${chalk.green('Active')}`);
    console.log(` ${chalk.bold('Environment')}    : ${envBadge}`);
    console.log(` ${chalk.bold('Bound Host')}     : ${chalk.yellow(host)}`);
    console.log(chalk.gray('─────────────────────────────────────────────────────────────'));
    console.log(` ${chalk.bold('Accessible URLs:')}`);
    for (const url of urls) {
        console.log(`  ${chalk.cyan('➜')} ${chalk.cyan.bold(url)}`);
    }
    console.log(chalk.gray('─────────────────────────────────────────────────────────────'));
}

async function start() {
    await checkAndRunSetup(envPath);
    dotenv.config({ path: envPath, override: true });
    const { connectDB } = require('./lib/db');
    const loadRoutes = require('./lib/router');
    const { startAutoPaymentCron } = require('./lib/autoPayment');
    const { getClientIp } = require('./lib/getIP');

    let routeCount = 0;

    try {
        await connectDB();

        await fastify.register(require('fastify-raw-body'), {
            field: 'rawBody',
            global: false,
            encoding: false,
            runFirst: true,
            routes: ['/api/v1/payment/oxapay/relay']
        });

        await fastify.register(require('@fastify/cors'), {
            origin: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: true
        });

        await fastify.register(require('@fastify/rate-limit'), {
            global: true,
            max: 300,
            timeWindow: '1 minute',
            keyGenerator: (req) => getClientIp(req)
        });

        await fastify.register(require('@fastify/multipart'), {
            limits: {
                fileSize: 1024 * 1024 * 1024,
                fieldSize: 1024 * 1024 * 1024
            }
        });

        await fastify.register(require('@fastify/static'), {
            root: [uploadDir, cacheDir],
            setHeaders: (res) => {
                res.setHeader('Content-Disposition', 'inline');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox;");
            }
        });

        fastify.get('/cdn/*', async (req, reply) => {
            try {
                const rawFilePath = req.params['*'];
                const resolved = resolveOriginalFile(rawFilePath);

                if (!resolved) {
                    return reply.code(404).send({ error: 'File not found' });
                }

                const rawType = normalizeQueryValue(req.query?.type);
                const rawSize = normalizeQueryValue(req.query?.size);
                const parsedSize = parseSize(rawSize);

                if (!parsedSize.valid) {
                    return reply.code(400).send({ error: 'Invalid size parameter' });
                }

                const { dirName, baseName, ext, originalFilePath, actualExt, actualFilename } = resolved;
                const isImage = imageExts.has(actualExt);

                if (!isImage) {
                    const relativePath = dirName === '.' ? actualFilename : path.posix.join(dirName, actualFilename);
                    return reply.sendFile(relativePath, uploadDir);
                }

                let targetType = normalizeTargetType(rawType);
                if (!targetType && ext !== actualExt && imageExts.has(ext)) {
                    targetType = normalizeTargetType(ext.slice(1));
                }

                const wantsResize = parsedSize.width !== null || parsedSize.height !== null;
                const wantsConvert = Boolean(targetType) && targetType !== actualExt.slice(1);

                if (!wantsResize && !wantsConvert) {
                    const relativePath = dirName === '.' ? actualFilename : path.posix.join(dirName, actualFilename);
                    return reply.sendFile(relativePath, uploadDir);
                }

                const metadata = await sharp(originalFilePath, { failOnError: false }).metadata().catch(() => null);

                if (!metadata) {
                    const relativePath = dirName === '.' ? actualFilename : path.posix.join(dirName, actualFilename);
                    return reply.sendFile(relativePath, uploadDir);
                }

                if ((metadata.pages && metadata.pages > 1) || metadata.animation) {
                    if (wantsResize || wantsConvert) {
                        const relativePath = dirName === '.' ? actualFilename : path.posix.join(dirName, actualFilename);
                        return reply.sendFile(relativePath, uploadDir);
                    }
                }

                const currentCacheDir = dirName === '.' ? cacheDir : path.join(cacheDir, dirName);

                if (!fs.existsSync(currentCacheDir)) {
                    fs.mkdirSync(currentCacheDir, { recursive: true });
                }

                const cacheExt = targetType || actualExt.slice(1);
                const cacheFilename = `${baseName}_${parsedSize.width || 'auto'}x${parsedSize.height || 'auto'}.${cacheExt}`;
                const cacheFilePath = path.join(currentCacheDir, cacheFilename);
                const relativeCachePath = dirName === '.' ? cacheFilename : path.posix.join(dirName, cacheFilename);

                if (fs.existsSync(cacheFilePath)) {
                    return reply.sendFile(relativeCachePath, cacheDir);
                }

                try {
                    let transformer = sharp(originalFilePath, { failOnError: false });

                    if (wantsResize) {
                        transformer = transformer.resize({
                            width: parsedSize.width || null,
                            height: parsedSize.height || null,
                            fit: 'inside',
                            withoutEnlargement: true
                        });
                    }

                    if (targetType) {
                        if (targetType === 'webp') transformer = transformer.webp({ quality: 80 });
                        else if (targetType === 'jpeg') transformer = transformer.jpeg({ quality: 80 });
                        else if (targetType === 'png') transformer = transformer.png();
                        else if (targetType === 'avif') transformer = transformer.avif({ quality: 80 });
                        else if (targetType === 'gif') transformer = transformer.gif();
                        else if (targetType === 'tiff') transformer = transformer.tiff();
                    }

                    await transformer.toFile(cacheFilePath);
                    return reply.sendFile(relativeCachePath, cacheDir);
                } catch (err) {
                    await removeIfExists(cacheFilePath);
                    console.error('[!] Sharp conversion error:', err);
                    const relativePath = dirName === '.' ? actualFilename : path.posix.join(dirName, actualFilename);
                    return reply.sendFile(relativePath, uploadDir);
                }
            } catch (err) {
                console.error('[!] CDN route error:', err);
                return reply.code(500).send({ error: 'Internal Server Error' });
            }
        });

        fastify.addHook('onRoute', (routeOptions) => {
            if (routeOptions.url.startsWith('/api')) {
                routeCount++;
            }
        });

        await fastify.register((instance, opts, done) => {
            const apiDir = path.join(__dirname, 'api');
            loadRoutes(instance, apiDir, '/api');
            done();
        });

        fastify.setNotFoundHandler(handleFrontendRouting);

        const port = Number(process.env.PORT) || 67777;
        const host = (
            process.env.BIND_IP ||
            process.env.BIND_HOST ||
            process.env.HOST ||
            process.env.IP ||
            '0.0.0.0'
        ).trim();

        await fastify.listen({ port, host });

        displayStartupDashboard(port, host, routeCount);
        startAutoPaymentCron();
    } catch (err) {
        console.error(chalk.red('\n[!] Error during initialization:'), err);
        process.exit(1);
    }
}

start();