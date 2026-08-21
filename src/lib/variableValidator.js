function parseRules(ruleString) {
    if (!ruleString || typeof ruleString !== 'string') return [];

    const rules = [];
    let i = 0;
    const str = ruleString.trim();

    while (i < str.length) {
        if (str.slice(i).startsWith('regex:')) {
            let endIdx = i + 6;
            if (str[endIdx] === '/') {
                endIdx++;
                while (endIdx < str.length) {
                    if (str[endIdx] === '\\') {
                        endIdx += 2;
                        continue;
                    }
                    if (str[endIdx] === '/') {
                        endIdx++;
                        while (endIdx < str.length && /[a-z]/i.test(str[endIdx])) {
                            endIdx++;
                        }
                        break;
                    }
                    endIdx++;
                }
            } else {
                while (endIdx < str.length && str[endIdx] !== '|') {
                    endIdx++;
                }
            }
            rules.push(str.slice(i, endIdx));
            i = endIdx;
            if (i < str.length && str[i] === '|') i++;
        } else {
            const nextPipe = str.indexOf('|', i);
            if (nextPipe === -1) {
                rules.push(str.slice(i));
                break;
            } else {
                rules.push(str.slice(i, nextPipe));
                i = nextPipe + 1;
            }
        }
    }

    return rules.map((r) => r.trim()).filter(Boolean);
}
function testRegex(regexRule, value) {
    const rawPattern = regexRule.slice(6);
    let pattern = rawPattern;
    let flags = '';

    if (rawPattern.startsWith('/')) {
        const lastSlash = rawPattern.lastIndexOf('/');
        if (lastSlash > 0) {
            pattern = rawPattern.slice(1, lastSlash);
            flags = rawPattern.slice(lastSlash + 1);
        }
    }

    try {
        const re = new RegExp(pattern, flags);
        return re.test(String(value));
    } catch {
        return false;
    }
}
function validateVariable(v, value) {
    const rules = parseRules(v.rules || '');
    const varName = v.name || v.env_variable;

    const isNullable = rules.some((r) => r.toLowerCase() === 'nullable');
    const isRequired = rules.some((r) => r.toLowerCase() === 'required');

    const strVal = value !== undefined && value !== null ? String(value).trim() : '';
    if (strVal.includes('\0')) {
        return { valid: false, error: `The ${varName} contains invalid characters.` };
    }
    if (strVal.length > 65535) {
        return { valid: false, error: `The ${varName} exceeds the maximum allowed length of 65,535 characters.` };
    }
    if (strVal === '') {
        if (isRequired) {
            return { valid: false, error: `The ${varName} field is required.` };
        }
        if (isNullable || !isRequired) {
            return { valid: true, value: '' };
        }
    }

    const isNumericType = rules.some((r) => ['numeric', 'integer', 'int'].includes(r.toLowerCase()));

    for (const rule of rules) {
        const ruleLower = rule.toLowerCase();

        if (ruleLower === 'required' || ruleLower === 'nullable' || ruleLower === 'string') {
            continue;
        }

        if (ruleLower === 'numeric') {
            if (isNaN(Number(strVal)) || strVal === '') {
                return { valid: false, error: `The ${varName} must be a valid number.` };
            }
            continue;
        }

        if (ruleLower === 'integer' || ruleLower === 'int') {
            if (!/^-?\d+$/.test(strVal)) {
                return { valid: false, error: `The ${varName} must be an integer.` };
            }
            continue;
        }

        if (ruleLower === 'boolean' || ruleLower === 'bool') {
            const lower = strVal.toLowerCase();
            if (!['true', 'false', '1', '0'].includes(lower)) {
                return { valid: false, error: `The ${varName} field must be true or false.` };
            }
            continue;
        }

        if (ruleLower.startsWith('min:')) {
            const min = Number(rule.slice(4));
            if (!isNaN(min)) {
                if (isNumericType) {
                    if (Number(strVal) < min) {
                        return { valid: false, error: `The ${varName} must be at least ${min}.` };
                    }
                } else {
                    if (strVal.length < min) {
                        return { valid: false, error: `The ${varName} must be at least ${min} characters.` };
                    }
                }
            }
            continue;
        }

        if (ruleLower.startsWith('max:')) {
            const max = Number(rule.slice(4));
            if (!isNaN(max)) {
                if (isNumericType) {
                    if (Number(strVal) > max) {
                        return { valid: false, error: `The ${varName} may not be greater than ${max}.` };
                    }
                } else {
                    if (strVal.length > max) {
                        return { valid: false, error: `The ${varName} may not be greater than ${max} characters.` };
                    }
                }
            }
            continue;
        }

        if (ruleLower.startsWith('size:')) {
            const size = Number(rule.slice(5));
            if (!isNaN(size)) {
                if (isNumericType) {
                    if (Number(strVal) !== size) {
                        return { valid: false, error: `The ${varName} must be ${size}.` };
                    }
                } else {
                    if (strVal.length !== size) {
                        return { valid: false, error: `The ${varName} must be ${size} characters.` };
                    }
                }
            }
            continue;
        }

        if (ruleLower.startsWith('between:')) {
            const [min, max] = rule.slice(8).split(',').map(Number);
            if (!isNaN(min) && !isNaN(max)) {
                if (isNumericType) {
                    const num = Number(strVal);
                    if (num < min || num > max) {
                        return { valid: false, error: `The ${varName} must be between ${min} and ${max}.` };
                    }
                } else {
                    if (strVal.length < min || strVal.length > max) {
                        return { valid: false, error: `The ${varName} must be between ${min} and ${max} characters.` };
                    }
                }
            }
            continue;
        }

        if (ruleLower.startsWith('in:')) {
            const options = rule.slice(3).split(',').map((s) => s.trim());
            if (!options.includes(strVal)) {
                return { valid: false, error: `The selected ${varName} is invalid. Allowed values: ${options.join(', ')}` };
            }
            continue;
        }

        if (ruleLower.startsWith('not_in:')) {
            const options = rule.slice(7).split(',').map((s) => s.trim());
            if (options.includes(strVal)) {
                return { valid: false, error: `The selected ${varName} is invalid.` };
            }
            continue;
        }

        if (rule.startsWith('regex:')) {
            if (!testRegex(rule, strVal)) {
                return { valid: false, error: `The ${varName} format is invalid.` };
            }
            continue;
        }

        if (ruleLower === 'alpha') {
            if (!/^[a-zA-Z]+$/.test(strVal)) {
                return { valid: false, error: `The ${varName} may only contain letters.` };
            }
            continue;
        }

        if (ruleLower === 'alpha_num') {
            if (!/^[a-zA-Z0-9]+$/.test(strVal)) {
                return { valid: false, error: `The ${varName} may only contain letters and numbers.` };
            }
            continue;
        }

        if (ruleLower === 'alpha_dash') {
            if (!/^[a-zA-Z0-9_-]+$/.test(strVal)) {
                return { valid: false, error: `The ${varName} may only contain letters, numbers, dashes, and underscores.` };
            }
            continue;
        }

        if (ruleLower === 'email') {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strVal)) {
                return { valid: false, error: `The ${varName} must be a valid email address.` };
            }
            continue;
        }

        if (ruleLower === 'url') {
            try {
                const parsedUrl = new URL(strVal);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                    return { valid: false, error: `The ${varName} format is invalid.` };
                }
            } catch {
                return { valid: false, error: `The ${varName} format is invalid.` };
            }
            continue;
        }

        if (ruleLower === 'ip') {
            const isIpv4 = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(strVal);
            const isIpv6 = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(strVal);
            if (!isIpv4 && !isIpv6) {
                return { valid: false, error: `The ${varName} must be a valid IP address.` };
            }
            continue;
        }

        if (ruleLower === 'json') {
            try {
                JSON.parse(strVal);
            } catch {
                return { valid: false, error: `The ${varName} must be a valid JSON string.` };
            }
            continue;
        }
    }

    return { valid: true, value: strVal };
}
function validateDockerImage(egg, dockerImage) {
    if (!dockerImage || typeof dockerImage !== 'string') {
        return { valid: false, error: 'A valid Docker container image is required.' };
    }

    const trimmedImage = dockerImage.trim();
    if (!/^[a-zA-Z0-9_./:-]+$/.test(trimmedImage)) {
        return { valid: false, error: 'The specified Docker image contains invalid characters.' };
    }

    let allowedImages = [];
    if (egg.docker_images && typeof egg.docker_images === 'object') {
        allowedImages = Object.values(egg.docker_images);
    } else if (egg.docker_image) {
        allowedImages = [egg.docker_image];
    }

    if (allowedImages.length > 0 && !allowedImages.includes(trimmedImage)) {
        return {
            valid: false,
            error: 'The selected Docker container image is not permitted for this egg template.'
        };
    }

    return { valid: true, image: trimmedImage };
}
function buildAndValidateEnv(eggVariables, inputEnv = {}, isUserContext = false) {
    const rawVariables = Array.isArray(eggVariables) ? eggVariables : [];
    const resultEnv = {};

    for (const v of rawVariables) {
        const key = v.env_variable;

        if (isUserContext && v.user_editable === false) {
            continue;
        }

        let candidateVal = inputEnv[key];
        if (candidateVal === undefined || candidateVal === null) {
            candidateVal = v.default_value !== undefined ? String(v.default_value) : '';
        }

        const validation = validateVariable(v, candidateVal);
        if (!validation.valid) {
            return {
                valid: false,
                error: validation.error,
                variable: key
            };
        }

        resultEnv[key] = validation.value;
    }

    return { valid: true, env: resultEnv };
}

module.exports = {
    parseRules,
    testRegex,
    validateVariable,
    validateDockerImage,
    buildAndValidateEnv
};