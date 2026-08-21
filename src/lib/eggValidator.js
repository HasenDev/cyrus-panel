'use strict';
const { Transform } = require('stream');
const MAX_EGG_SIZE = 1024 * 1024;
const SUPPORTED_META_VERSIONS = ['PTDL_v1', 'PTDL_v2', 'PLCN_v1'];
const VALID_CONFIG_PARSERS = [
    'properties',
    'ini',
    'json',
    'yaml',
    'yml',
    'xml',
    'file',
    'env'
];
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const ENV_VAR_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DOCKER_IMAGE_REGEX = /^(?:(?=[^:\/]{1,253})(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?$/;
class EggValidationError extends Error {
    constructor(message, field = null, value = undefined) {
        super(message);
        this.name = 'EggValidationError';
        this.field = field;
        this.value = value;
        Error.captureStackTrace(this, this.constructor);
    }
}
const createSizeLimiter = (maxBytes = MAX_EGG_SIZE) => {
    let totalBytes = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                const limitKb = Math.round(maxBytes / 1024);
                const error = new EggValidationError(
                    `File exceeds maximum allowed size of ${limitKb}KB.`,
                    'file_size',
                    totalBytes
                );
                return callback(error);
            }
            callback(null, chunk);
        }
    });
};
function parseAndValidateConfigSection(raw, fieldName) {
    if (raw === null || raw === undefined) {
        return {};
    }

    let parsed = raw;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) {
            return {};
        }
        try {
            parsed = JSON.parse(trimmed);
        } catch (err) {
            throw new EggValidationError(
                `Invalid Egg: "${fieldName}" must be valid JSON: ${err.message}`,
                fieldName,
                raw
            );
        }
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        throw new EggValidationError(
            `Invalid Egg: "${fieldName}" must resolve to a valid JSON object.`,
            fieldName,
            raw
        );
    }

    return parsed;
}
function validateConfigBlock(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new EggValidationError('Invalid Egg: "config" property must be an object.', 'config', config);
    }

    if (config.files !== undefined && config.files !== null) {
        const filesObj = parseAndValidateConfigSection(config.files, 'config.files');
        for (const [filename, fileConfig] of Object.entries(filesObj)) {
            if (typeof fileConfig !== 'object' || fileConfig === null) {
                throw new EggValidationError(
                    `Invalid Egg: "config.files['${filename}']" must be an object definition.`,
                    `config.files.${filename}`
                );
            }
            if (fileConfig.parser && typeof fileConfig.parser === 'string') {
                if (!VALID_CONFIG_PARSERS.includes(fileConfig.parser.toLowerCase())) {
                    throw new EggValidationError(
                        `Invalid Egg: "config.files['${filename}'].parser" must be one of: ${VALID_CONFIG_PARSERS.join(', ')}. Received "${fileConfig.parser}".`,
                        `config.files.${filename}.parser`,
                        fileConfig.parser
                    );
                }
            }
        }
    }

    if (config.startup !== undefined && config.startup !== null) {
        parseAndValidateConfigSection(config.startup, 'config.startup');
    }

    if (config.logs !== undefined && config.logs !== null) {
        parseAndValidateConfigSection(config.logs, 'config.logs');
    }

    if (config.stop !== undefined && config.stop !== null && typeof config.stop !== 'string') {
        throw new EggValidationError('Invalid Egg: "config.stop" must be a string if provided.', 'config.stop', config.stop);
    }
}
function validateAndNormalizeDockerImages(jsonObj) {
    const images = {};

    if (jsonObj.docker_images && typeof jsonObj.docker_images === 'object' && !Array.isArray(jsonObj.docker_images)) {
        const keys = Object.keys(jsonObj.docker_images);
        if (keys.length === 0) {
            throw new EggValidationError('Invalid Egg: "docker_images" cannot be empty.', 'docker_images');
        }

        for (const [name, imageUri] of Object.entries(jsonObj.docker_images)) {
            if (typeof imageUri !== 'string' || !imageUri.trim()) {
                throw new EggValidationError(
                    `Invalid Egg: Docker image for "${name}" must be a non-empty string.`,
                    `docker_images.${name}`,
                    imageUri
                );
            }
            images[name.trim()] = imageUri.trim();
        }
    } else if (Array.isArray(jsonObj.images) && jsonObj.images.length > 0) {
        jsonObj.images.forEach((img, idx) => {
            if (typeof img !== 'string' || !img.trim()) {
                throw new EggValidationError(
                    `Invalid Egg: "images[${idx}]" must be a non-empty string.`,
                    `images[${idx}]`,
                    img
                );
            }
            images[img.trim()] = img.trim();
        });
    } else if (typeof jsonObj.image === 'string' && jsonObj.image.trim()) {
        images[jsonObj.image.trim()] = jsonObj.image.trim();
    } else {
        throw new EggValidationError(
            'Invalid Egg: At least one Docker image must be specified under "docker_images".',
            'docker_images'
        );
    }

    return images;
}
function validateInstallationScript(jsonObj) {
    const scripts = jsonObj.scripts;
    if (scripts !== undefined && scripts !== null) {
        if (typeof scripts !== 'object' || Array.isArray(scripts)) {
            throw new EggValidationError('Invalid Egg: "scripts" must be an object.', 'scripts', scripts);
        }

        if (scripts.installation && typeof scripts.installation === 'object') {
            const install = scripts.installation;
            const hasScriptContent = install.script !== null && install.script !== undefined && String(install.script).trim().length > 0;

            if (hasScriptContent) {
                if (!install.container || typeof install.container !== 'string' || !install.container.trim()) {
                    throw new EggValidationError(
                        'Invalid Egg: "scripts.installation.container" image is required when an install script is provided.',
                        'scripts.installation.container'
                    );
                }
                if (!install.entrypoint || typeof install.entrypoint !== 'string' || !install.entrypoint.trim()) {
                    throw new EggValidationError(
                        'Invalid Egg: "scripts.installation.entrypoint" is required when an install script is provided.',
                        'scripts.installation.entrypoint'
                    );
                }
            }
        }
    }
}
function validateVariables(variables) {
    if (!Array.isArray(variables)) {
        throw new EggValidationError('Invalid Egg: "variables" field must be an array.', 'variables', variables);
    }

    const seenEnvVars = new Set();

    variables.forEach((v, idx) => {
        const prefix = `variables[${idx}]`;

        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            throw new EggValidationError(`Invalid Egg variable at index ${idx}: Must be an object.`, prefix, v);
        }

        if (!v.name || typeof v.name !== 'string' || !v.name.trim()) {
            throw new EggValidationError(`Invalid Egg variable at index ${idx}: "name" is required.`, `${prefix}.name`);
        }
        if (v.name.length > 191) {
            throw new EggValidationError(`Invalid Egg variable at index ${idx}: "name" exceeds 191 characters.`, `${prefix}.name`, v.name);
        }

        if (!v.env_variable || typeof v.env_variable !== 'string' || !v.env_variable.trim()) {
            throw new EggValidationError(`Invalid Egg variable at index ${idx}: "env_variable" is required.`, `${prefix}.env_variable`);
        }

        const envVar = v.env_variable.trim();
        if (envVar.length > 191) {
            throw new EggValidationError(`Invalid Egg variable at index ${idx}: "env_variable" exceeds 191 characters.`, `${prefix}.env_variable`, envVar);
        }

        if (!ENV_VAR_REGEX.test(envVar)) {
            throw new EggValidationError(
                `Invalid Egg variable at index ${idx}: "env_variable" ("${envVar}") must contain only alphanumeric characters and underscores, and cannot start with a number.`,
                `${prefix}.env_variable`,
                envVar
            );
        }

        const lowerEnvVar = envVar.toLowerCase();
        if (seenEnvVars.has(lowerEnvVar)) {
            throw new EggValidationError(
                `Invalid Egg: Duplicate environment variable "${envVar}" defined at index ${idx}.`,
                `${prefix}.env_variable`,
                envVar
            );
        }
        seenEnvVars.add(lowerEnvVar);

        if (!v.rules || typeof v.rules !== 'string' || !v.rules.trim()) {
            throw new EggValidationError(
                `Invalid Egg variable "${envVar}": "rules" field is required.`,
                `${prefix}.rules`
            );
        }
        if (v.rules.length > 500) {
            throw new EggValidationError(
                `Invalid Egg variable "${envVar}": "rules" string exceeds 500 characters.`,
                `${prefix}.rules`,
                v.rules
            );
        }

        if (v.user_viewable !== undefined && typeof v.user_viewable !== 'boolean' && v.user_viewable !== 0 && v.user_viewable !== 1) {
            throw new EggValidationError(`Invalid Egg variable "${envVar}": "user_viewable" must be a boolean.`, `${prefix}.user_viewable`);
        }
        if (v.user_editable !== undefined && typeof v.user_editable !== 'boolean' && v.user_editable !== 0 && v.user_editable !== 1) {
            throw new EggValidationError(`Invalid Egg variable "${envVar}": "user_editable" must be a boolean.`, `${prefix}.user_editable`);
        }
    });
}
function validateEggData(jsonObj, options = {}) {
    const { allowLegacy = true, throwOnError = true } = options;
    const errors = [];

    const reportError = (message, field, value) => {
        const err = new EggValidationError(message, field, value);
        if (throwOnError) {
            throw err;
        }
        errors.push(message);
    };

    try {
        if (!jsonObj || typeof jsonObj !== 'object' || Array.isArray(jsonObj)) {
            reportError('Invalid Egg format: Root payload must be a JSON object.', 'root', jsonObj);
            return throwOnError ? false : { valid: false, errors };
        }

        if (jsonObj.meta !== undefined && jsonObj.meta !== null) {
            if (typeof jsonObj.meta !== 'object' || Array.isArray(jsonObj.meta)) {
                reportError('Invalid Egg: "meta" must be an object.', 'meta', jsonObj.meta);
            } else if (jsonObj.meta.version && !SUPPORTED_META_VERSIONS.includes(jsonObj.meta.version)) {
                if (!allowLegacy) {
                    reportError(
                        `Invalid Egg: Unsupported meta version "${jsonObj.meta.version}". Supported versions: ${SUPPORTED_META_VERSIONS.join(', ')}`,
                        'meta.version',
                        jsonObj.meta.version
                    );
                }
            }
        }

        if (!jsonObj.name || typeof jsonObj.name !== 'string' || !jsonObj.name.trim()) {
            reportError('Invalid Egg: "name" property is required.', 'name', jsonObj.name);
        } else if (jsonObj.name.trim().length > 191) {
            reportError('Invalid Egg: "name" must not exceed 191 characters.', 'name', jsonObj.name);
        }

        if (jsonObj.author !== undefined && jsonObj.author !== null) {
            if (typeof jsonObj.author !== 'string' || !EMAIL_REGEX.test(jsonObj.author.trim())) {
                reportError(
                    `Invalid Egg: "author" must be a valid email address. Received "${jsonObj.author}".`,
                    'author',
                    jsonObj.author
                );
            }
        }

        if (typeof jsonObj.startup !== 'string' || !jsonObj.startup.trim()) {
            reportError('Invalid Egg: "startup" command string is required.', 'startup', jsonObj.startup);
        }

        if (jsonObj.description !== undefined && jsonObj.description !== null && typeof jsonObj.description !== 'string') {
            reportError('Invalid Egg: "description" must be a string.', 'description', jsonObj.description);
        }

        if (jsonObj.features !== undefined && jsonObj.features !== null) {
            if (!Array.isArray(jsonObj.features)) {
                reportError('Invalid Egg: "features" must be an array of strings or null.', 'features', jsonObj.features);
            } else {
                jsonObj.features.forEach((feat, idx) => {
                    if (typeof feat !== 'string' || !feat.trim()) {
                        reportError(`Invalid Egg: "features[${idx}]" must be a non-empty string.`, `features[${idx}]`, feat);
                    }
                });
            }
        }

        if (jsonObj.file_denylist !== undefined && jsonObj.file_denylist !== null) {
            if (!Array.isArray(jsonObj.file_denylist)) {
                reportError('Invalid Egg: "file_denylist" must be an array of strings or null.', 'file_denylist', jsonObj.file_denylist);
            }
        }

        validateAndNormalizeDockerImages(jsonObj);

        if (jsonObj.config !== undefined && jsonObj.config !== null) {
            validateConfigBlock(jsonObj.config);
        }

        validateInstallationScript(jsonObj);

        if (jsonObj.variables !== undefined && jsonObj.variables !== null) {
            validateVariables(jsonObj.variables);
        }
    } catch (err) {
        if (err instanceof EggValidationError && !throwOnError) {
            errors.push(err.message);
        } else {
            throw err;
        }
    }

    if (!throwOnError) {
        return {
            valid: errors.length === 0,
            errors
        };
    }

    return true;
}
function normalizeEggData(jsonObj) {
    validateEggData(jsonObj);

    const dockerImages = validateAndNormalizeDockerImages(jsonObj);

    return {
        _comment: jsonObj._comment || 'DO NOT EDIT: FILE GENERATED AUTOMATICALLY BY PTERODACTYL PANEL - PTERODACTYL.IO',
        meta: {
            version: 'PTDL_v2',
            update_url: jsonObj.meta?.update_url || null
        },
        exported_at: jsonObj.exported_at || new Date().toISOString(),
        name: jsonObj.name.trim(),
        author: jsonObj.author ? jsonObj.author.trim() : '',
        description: jsonObj.description ? jsonObj.description.trim() : '',
        features: Array.isArray(jsonObj.features) ? jsonObj.features : null,
        docker_images: dockerImages,
        file_denylist: Array.isArray(jsonObj.file_denylist) ? jsonObj.file_denylist : [],
        startup: jsonObj.startup.trim(),
        config: {
            files: typeof jsonObj.config?.files === 'string' ? jsonObj.config.files : JSON.stringify(jsonObj.config?.files || {}),
            startup: typeof jsonObj.config?.startup === 'string' ? jsonObj.config.startup : JSON.stringify(jsonObj.config?.startup || {}),
            logs: typeof jsonObj.config?.logs === 'string' ? jsonObj.config.logs : JSON.stringify(jsonObj.config?.logs || {}),
            stop: jsonObj.config?.stop || ''
        },
        scripts: {
            installation: {
                script: jsonObj.scripts?.installation?.script ?? jsonObj.script_install ?? null,
                container: jsonObj.scripts?.installation?.container ?? jsonObj.script_container ?? 'ghcr.io/pterodactyl/installers:alpine',
                entrypoint: jsonObj.scripts?.installation?.entrypoint ?? jsonObj.script_entry ?? 'ash'
            }
        },
        variables: Array.isArray(jsonObj.variables) ? jsonObj.variables.map(v => ({
            name: v.name.trim(),
            description: v.description ? v.description.trim() : '',
            env_variable: v.env_variable.trim(),
            default_value: v.default_value !== undefined ? String(v.default_value) : '',
            user_viewable: Boolean(v.user_viewable),
            user_editable: Boolean(v.user_editable),
            rules: v.rules.trim(),
            field_type: v.field_type || 'text'
        })) : []
    };
}

module.exports = {
    MAX_EGG_SIZE,
    SUPPORTED_META_VERSIONS,
    VALID_CONFIG_PARSERS,
    EggValidationError,
    createSizeLimiter,
    validateEggData,
    normalizeEggData
};