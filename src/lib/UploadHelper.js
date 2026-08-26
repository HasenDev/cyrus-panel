const fs = require('fs');
const path = require('path');
const {
    pipeline
} = require('stream/promises');
const {
    Transform
} = require('stream');
const snowflake = require('./snowflake');
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico"]);
const MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/x-icon": ".ico",
    "image/svg+xml": ".svg",
};
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
let imageTypeModulePromise = null;
const getImageType = async () => {
    if (!imageTypeModulePromise) {
        imageTypeModulePromise = import("image-type");
    }
    return await imageTypeModulePromise;
};
const getEffectiveMaxSize = (maxSizeBytes) => {
    if (typeof maxSizeBytes !== "number" || !Number.isFinite(maxSizeBytes) || maxSizeBytes <= 0) {
        return DEFAULT_MAX_SIZE_BYTES;
    }
    return Math.min(maxSizeBytes, DEFAULT_MAX_SIZE_BYTES);
};
const createSizeLimiter = (maxBytes) => {
    let total = 0;
    return new Transform({
        transform(chunk, enc, callback) {
            total += chunk.length;
            if (total > maxBytes) {
                const mb = (maxBytes / (1024 * 1024)).toFixed(1);
                callback(new Error(`Image exceeds max size limit of ${mb}MB`));
                return;
            }
            callback(null, chunk);
        },
    });
};
const verifyImageType = async (buffer, expectedExt = null) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("Invalid image data");
    }
    const normalizedExpectedExt = expectedExt === ".jpeg" ? ".jpg" : expectedExt;
    if (normalizedExpectedExt === ".svg") {
        const sample = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("utf8").replace(/^\uFEFF/, "").trim();
        const looksLikeSvg = /^<\?xml[\s\S]*?<svg\b/i.test(sample) || /^<svg\b/i.test(sample);
        if (!looksLikeSvg) {
            throw new Error("File content is not a valid SVG image");
        }
        return {
            ext: "svg",
            mime: "image/svg+xml",
        };
    }
    const {
        default: imageType,
        minimumBytes
    } = await getImageType();
    const detectionBuffer = buffer.subarray(0, Math.min(buffer.length, minimumBytes));
    const detected = await imageType(detectionBuffer);
    if (!detected) {
        throw new Error("Unable to verify image file type");
    }
    const detectedExt = detected.ext === "jpeg" ? "jpg" : detected.ext;
    const expectedWithoutDot = normalizedExpectedExt ? normalizedExpectedExt.replace(".", "").toLowerCase() : null;
    if (expectedWithoutDot && detectedExt !== expectedWithoutDot) {
        throw new Error(`File extension does not match its actual type`);
    }
    if (!ALLOWED_IMAGE_EXTENSIONS.has(`.${detectedExt}`)) {
        throw new Error("Unsupported image format");
    }
    return detected;
};
class UploadHelper {
    static async uploadBase64Stream(base64Str, basePath, identifier, oldFileUrl = null, maxSizeBytes = null) {
        const effectiveMaxSize = getEffectiveMaxSize(maxSizeBytes);
        if (!base64Str || typeof base64Str !== "string" || !base64Str.startsWith("data:image/")) {
            return null;
        }
        const commaIdx = base64Str.indexOf(",");
        if (commaIdx === -1) {
            throw new Error("Invalid image format");
        }
        const header = base64Str.slice(0, commaIdx);
        const base64Data = base64Str.slice(commaIdx + 1);
        const mimeMatch = header.match(/^data:image\/([a-zA-Z0-9+.-]+);base64$/i);
        if (!mimeMatch) {
            throw new Error("Invalid image format");
        }
        let ext = `.${mimeMatch[1].toLowerCase()}`;
        if (ext === ".jpeg") {
            ext = ".jpg";
        }
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
            throw new Error("Unsupported image format");
        }
        const estimatedDecodedSize = Math.floor((base64Data.length * 3) / 4) - (base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0);
        if (estimatedDecodedSize > effectiveMaxSize) {
            const mb = (effectiveMaxSize / (1024 * 1024)).toFixed(1);
            throw new Error(`Image exceeds max size limit of ${mb}MB`);
        }
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length > effectiveMaxSize) {
            const mb = (effectiveMaxSize / (1024 * 1024)).toFixed(1);
            throw new Error(`Image exceeds max size limit of ${mb}MB`);
        }
        await verifyImageType(buffer, ext);
        return await this._processUpload(buffer, basePath, identifier, ext, oldFileUrl, effectiveMaxSize);
    }
    static async uploadMultipartStream(part, basePath, identifier, oldFileUrl = null, maxSizeBytes = null) {
        if (!part) return null;
        const effectiveMaxSize = getEffectiveMaxSize(maxSizeBytes);
        let fileData;
        if (Buffer.isBuffer(part)) {
            fileData = part;
        } else if (typeof part.toBuffer === "function") {
            fileData = await part.toBuffer();
        } else if (part.file && Buffer.isBuffer(part.file)) {
            fileData = part.file;
        } else {
            fileData = part.file || part;
        }
        if (Buffer.isBuffer(fileData) && fileData.length > effectiveMaxSize) {
            const mb = (effectiveMaxSize / (1024 * 1024)).toFixed(1);
            throw new Error(`Image exceeds max size limit of ${mb}MB`);
        }
        const mimeType = String(part.mimetype || part.mime || "").toLowerCase();
        if (mimeType && !mimeType.startsWith("image/")) {
            throw new Error("Only image files are allowed");
        }
        const rawFilename = part.filename || identifier;
        const safeFilename = path.basename(String(rawFilename)).replace(/[^a-zA-Z0-9._-]/g, "_");
        let ext = path.extname(safeFilename).toLowerCase();
        if (!ext || ext === ".") {
            ext = MIME_TO_EXT[mimeType] || "";
        }
        if (ext === ".jpeg") {
            ext = ".jpg";
        }
        if (!ext || !ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
            if (mimeType.startsWith("image/")) {
                ext = ".jpg";
            } else {
                throw new Error("Unsupported image file extension");
            }
        }
        /*
         * When the upload has already been buffered, verify its contents.
         */
        if (Buffer.isBuffer(fileData)) {
            await verifyImageType(fileData, ext);
        }
        return await this._processUpload(fileData, basePath, identifier, ext, oldFileUrl, effectiveMaxSize);
    }
    static async _processUpload(dataStreamOrBuffer, basePath, identifier, ext, oldFileUrl, maxSizeBytes = null) {
        const effectiveMaxSize = getEffectiveMaxSize(maxSizeBytes);
        if (oldFileUrl) {
            this.deleteOldAsset(oldFileUrl, basePath);
        }
        const fileId = snowflake.generate();
        const dirPath = path.join(process.cwd(), "uploads", basePath, fileId);
        await fs.promises.mkdir(dirPath, {
            recursive: true
        });
        const fileName = `${identifier}${ext}`;
        const filePath = path.join(dirPath, fileName);
        try {
            if (Buffer.isBuffer(dataStreamOrBuffer)) {
                if (dataStreamOrBuffer.length > effectiveMaxSize) {
                    throw new Error(`Image exceeds max size limit of ${(
              effectiveMaxSize /
              (1024 * 1024)
            ).toFixed(1)}MB`);
                }
                await fs.promises.writeFile(filePath, dataStreamOrBuffer);
            } else {
                const sizeLimiter = createSizeLimiter(effectiveMaxSize);
                await pipeline(dataStreamOrBuffer, sizeLimiter, fs.createWriteStream(filePath));
            }
        } catch (error) {
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, {
                    recursive: true,
                    force: true,
                });
            }
            throw error;
        }
        return `/cdn/${basePath}/${fileId}/${fileName}`;
    }
    static deleteOldAsset(oldUrl, expectedPrefix) {
        if (!oldUrl || typeof oldUrl !== "string") {
            return;
        }
        let normalizedUrl = oldUrl;
        if (normalizedUrl.startsWith("http://") || normalizedUrl.startsWith("https://")) {
            try {
                normalizedUrl = new URL(oldUrl).pathname;
            } catch (e) {
                normalizedUrl = oldUrl.replace(/^https?:\/\/[^\/]+/, "");
            }
        }
        const prefixPath = `/cdn/${expectedPrefix}`;
        if (!normalizedUrl.startsWith(prefixPath) && !normalizedUrl.startsWith("/cdn/")) {
            return;
        }
        try {
            const relativePath = normalizedUrl.replace("/cdn/", "");
            const fullPath = path.join(process.cwd(), "uploads", relativePath);
            const dirPath = path.dirname(fullPath);
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, {
                    recursive: true,
                    force: true,
                });
            }
        } catch (e) {}
    }
}
module.exports = UploadHelper;
