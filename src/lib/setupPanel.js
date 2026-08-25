const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const dotenv = require('dotenv');
const chalk = require('chalk');
const { MongoClient } = require('mongodb');

let projectAuth = null;
try {
    projectAuth = require('./auth');
} catch {}

async function hashPassword(password) {
    if (projectAuth && typeof projectAuth.hashPassword === 'function') {
        return await projectAuth.hashPassword(password);
    }
    try {
        const bcrypt = require('bcrypt');
        return await bcrypt.hash(password, 10);
    } catch {}
    try {
        const bcryptjs = require('bcryptjs');
        return await bcryptjs.hash(password, 10);
    } catch {}
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) return reject(err);
            resolve(`${salt}:${derivedKey.toString('hex')}`);
        });
    });
}

function createPromptInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

function ask(rl, query, defaultValue = '') {
    return new Promise((resolve) => {
        const formattedQuery = defaultValue !== '' 
            ? `${chalk.cyan('?')} ${chalk.bold(query)} ${chalk.gray(`(${defaultValue})`)}: `
            : `${chalk.cyan('?')} ${chalk.bold(query)}: `;
        
        rl.question(formattedQuery, (answer) => {
            const trimmed = answer.trim();
            resolve(trimmed === '' ? defaultValue : trimmed);
        });
    });
}

async function askConfirm(rl, query, defaultYes = true) {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = await ask(rl, `${query} [${hint}]`, defaultYes ? 'y' : 'n');
    const lower = answer.toLowerCase();
    return lower === 'y' || lower === 'yes';
}

async function askValidated(rl, query, defaultValue, validator) {
    while (true) {
        const val = await ask(rl, query, defaultValue);
        const error = validator(val);
        if (!error) return val;
        console.log(chalk.red(`  └─ ✖ ${error}`));
    }
}

function createSpinner(spinnerText) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    let timer = null;

    return {
        start() {
            process.stdout.write('\x1B[?25l');
            timer = setInterval(() => {
                const frame = chalk.cyan(frames[i = (i + 1) % frames.length]);
                process.stdout.write(`\r ${frame} ${chalk.yellow(spinnerText)}`);
            }, 80);
        },
        succeed(successText) {
            clearInterval(timer);
            process.stdout.write(`\r ${chalk.green('✔')} ${chalk.green(successText)}\n`);
            process.stdout.write('\x1B[?25h');
        },
        fail(failText) {
            clearInterval(timer);
            process.stdout.write(`\r ${chalk.red('✖')} ${chalk.red(failText)}\n`);
            process.stdout.write('\x1B[?25h');
        }
    };
}

const generateRandomSecret = (bytes = 32) => {
    return crypto.randomBytes(bytes).toString('hex');
};

const verifyMongoConnection = async (uri) => {
    if (typeof uri !== 'string' || (!uri.trim().startsWith('mongodb://') && !uri.trim().startsWith('mongodb+srv://'))) {
        return { success: false, error: 'Invalid MongoDB connection URI format' };
    }

    let client = null;
    try {
        client = new MongoClient(uri.trim(), {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });

        await client.connect();
        await client.db('CyrusPanel').admin().ping();
        await client.close();
        return { success: true };
    } catch (err) {
        if (client) {
            try {
                await client.close();
            } catch {}
        }
        return { success: false, error: err.message || 'Unknown connection error' };
    }
};

function displaySection(title) {
    console.log(`\n${chalk.bgCyan.white.bold(` ${title} `)}`);
    console.log(chalk.white('─'.repeat(60)));
}

function displayNotice(title, message) {
    console.log(`\n${chalk.bgYellow.white.bold(` ${title} `)}`);
    console.log(chalk.yellow(message));
    console.log(chalk.white('─'.repeat(60)));
}

async function runInteractiveSetup(envPath) {
    console.clear();
    console.log(chalk.cyan.bold('┌─────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan.bold('│                  CYRUS PANEL SETUP WIZARD                   │'));
    console.log(chalk.cyan.bold('└─────────────────────────────────────────────────────────────┘'));

    const rl = createPromptInterface();

    try {
        displaySection('1. SERVER & NETWORK CONFIGURATION');

        const bindIp = await askValidated(rl, 'Enter server bind IP address', '0.0.0.0', (val) => {
            if (!val.trim()) return 'Bind IP cannot be empty';
        });

        const port = await askValidated(rl, 'Enter server listening port', '57777', (val) => {
            const p = parseInt(val, 10);
            if (isNaN(p) || p <= 0 || p > 65535) return 'Port must be a valid number (1-65535)';
        });

        const apiUrl = await askValidated(rl, 'Enter the public Panel URL', 'https://panel.yourdomain.com', (val) => {
            if (!val.trim()) return 'Panel URL is required';
            if (!/^https?:\/\//i.test(val.trim())) return 'Panel URL must start with http:// or https://';
        });

        displayNotice(
            'REVERSE PROXY & EXPOSURE GUIDANCE',
            `To expose your panel safely to the internet, we recommend:\n\n` +
            `• Cloudflare Tunnels (Zero Trust): Forward traffic directly to http://${bindIp}:${port} without opening inbound ports. Cloudflare handles the public HTTPS endpoint and provides its edge protection.\n` +
            `• Nginx / Caddy: Forward port ${port} on this host with a valid SSL certificate.\n\n` +
            `If you need help setting that up. check out: https://cyrus.admibot.xyz/docs/category/reverse-proxy`
        );

        displaySection('2. DATABASE CONFIGURATION');

        let mongoUri = '';
        let mongoValid = false;

        while (!mongoValid) {
            mongoUri = await askValidated(rl, 'Enter your MongoDB Connection URI', 'mongodb://127.0.0.1:27017/CyrusPanel', (val) => {
                if (!val.trim().startsWith('mongodb://') && !val.trim().startsWith('mongodb+srv://')) {
                    return 'URI must start with mongodb:// or mongodb+srv://';
                }
            });

            const spinner = createSpinner('Testing MongoDB database connection...');
            spinner.start();

            const result = await verifyMongoConnection(mongoUri.trim());

            if (result.success) {
                spinner.succeed('MongoDB connection established and verified successfully!');
                mongoValid = true;
            } else {
                spinner.fail(`MongoDB Connection Failed: ${result.error}`);
                const retry = await askConfirm(rl, 'Would you like to re-enter the MongoDB URI?', true);
                if (!retry) {
                    console.log(chalk.red('\n[!] Setup aborted due to database verification failure.\n'));
                    rl.close();
                    process.exit(1);
                }
            }
        }

        displaySection('3. ADMINISTRATOR ACCOUNT SETUP');

        let mongoClient = new MongoClient(mongoUri.trim(), {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });

        await mongoClient.connect();
        const db = mongoClient.db('CyrusPanel');
        const usersCollection = db.collection('users');

        const existingAdmin = await usersCollection.findOne({ admin: true });
        let shouldCreateAdmin = false;

        if (existingAdmin) {
            displayNotice(
                'PANEL ALREADY INITIALIZED',
                `An existing administrator account (${chalk.cyan(existingAdmin.username || existingAdmin.email)}) was detected in the database.\nIt appears this Cyrus database was already set up previously.`
            );
            shouldCreateAdmin = await askConfirm(rl, 'Would you like to create another administrator account?', false);
        } else {
            console.log(chalk.yellow('No administrator account was found in the database. An administrator account is required.\n'));
            shouldCreateAdmin = true;
        }

        if (shouldCreateAdmin) {
            let adminEmail = '';
            while (true) {
                const emailInput = await ask(rl, 'Enter Administrator Email');
                const cleanEmail = emailInput.trim().toLowerCase();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (!cleanEmail) {
                    console.log(chalk.red('  └─ Email address is required.'));
                    continue;
                }
                if (cleanEmail.length > 254 || !emailRegex.test(cleanEmail)) {
                    console.log(chalk.red('  └─ Please enter a valid email address.'));
                    continue;
                }
                const [localPart, domainPart] = cleanEmail.split('@');
                const isGmail = domainPart === 'gmail.com' || domainPart === 'googlemail.com';
                if (isGmail && localPart.includes('.')) {
                    console.log(chalk.red('  └─ Gmail addresses cannot contain extra dots.'));
                    continue;
                }
                const emailExists = await usersCollection.findOne({ email: cleanEmail });
                if (emailExists) {
                    console.log(chalk.red('  └─ Email address is already registered.'));
                    continue;
                }
                adminEmail = cleanEmail;
                break;
            }

            let adminUsername = '';
            while (true) {
                const userInput = await ask(rl, 'Enter Administrator Username');
                const cleanUsername = userInput.trim();
                const usernameRegex = /^[a-zA-Z0-9 ]{2,16}$/;

                if (!cleanUsername) {
                    console.log(chalk.red('  └─ Username is required.'));
                    continue;
                }
                if (!usernameRegex.test(cleanUsername)) {
                    console.log(chalk.red('  └─ Username must be 2-16 alphanumeric characters or spaces.'));
                    continue;
                }
                const usernameExists = await usersCollection.findOne({
                    username: { $regex: new RegExp(`^${cleanUsername.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') }
                });
                if (usernameExists) {
                    console.log(chalk.red('  └─ Username is already taken.'));
                    continue;
                }
                adminUsername = cleanUsername;
                break;
            }

            let adminPassword = '';
            while (true) {
                const passInput = await ask(rl, 'Enter Administrator Password');
                if (!passInput || passInput.length < 6) {
                    console.log(chalk.red('  └─ Password must be at least 6 characters long.'));
                    continue;
                }
                if (passInput.length > 72) {
                    console.log(chalk.red('  └─ Password is too long. Maximum length is 72 characters.'));
                    continue;
                }
                adminPassword = passInput;
                break;
            }

            const adminSpinner = createSpinner('Creating administrator account...');
            adminSpinner.start();

            try {
                const passwordHash = await hashPassword(adminPassword);
                const userId = crypto.randomUUID();
                const timestamp = Date.now();

                const newAdminDoc = {
                    _id: userId,
                    email: adminEmail,
                    username: adminUsername,
                    password: passwordHash,
                    admin: true,
                    banned: null,
                    bot: false,
                    emailVerified: true,
                    inviteCodeUsed: null,
                    acceptTosAndPrivacy: true,
                    acceptedTosAndPrivacyAt: timestamp,
                    createdAt: timestamp
                };

                await usersCollection.insertOne(newAdminDoc);
                adminSpinner.succeed(`Administrator account '${adminUsername}' created successfully!`);
            } catch (err) {
                adminSpinner.fail(`Failed to create administrator account: ${err.message}`);
                await mongoClient.close();
                rl.close();
                process.exit(1);
            }
        }

        await mongoClient.close();

        displaySection('4. AUTHENTICATION & SECURITY');

        const autoJwt = generateRandomSecret(32);
        const useAutoJwt = await askConfirm(rl, `Use auto-generated secure JWT secret? (${autoJwt.slice(0, 16)}...)`, true);

        let jwtSecret = autoJwt;
        if (!useAutoJwt) {
            jwtSecret = await askValidated(rl, 'Enter custom JWT secret key', '', (val) => {
                if (val.trim().length < 16) return 'JWT secret must be at least 16 characters long';
            });
        }

        displaySection('5. PANEL CUSTOMIZATION');

        const panelName = await ask(rl, 'Panel Name', 'Cyrus');
        const panelDescription = await ask(rl, 'Panel Description', 'High-performance cloud compute and service management panel.');
        const panelIcon = await ask(rl, 'Panel Icon URL (Optional, press Enter for default)', '');
        const accentColor = await askValidated(rl, 'Panel Accent Color (Hex)', '#6366f1', (val) => {
            if (val && !/^#[0-9A-Fa-f]{6}$/.test(val.trim())) return 'Must be a valid hex color (e.g. #6366f1)';
        });
        const defaultMaxDeployments = await askValidated(rl, 'Default Maximum Deployments per user', '10', (val) => {
            const n = parseInt(val, 10);
            if (isNaN(n) || n < 1) return 'Must be a positive integer';
        });

        displaySection('6. VERIFICATION & MAIL SERVICES');

        const recaptchaEnabled = await askConfirm(rl, 'Enable Google reCAPTCHA verification?', false);
        let recaptchaPublicKey = '';
        let recaptchaSecretKey = '';

        if (recaptchaEnabled) {
            displayNotice(
                'RECAPTCHA DOMAIN NOTICE',
                `Ensure your Panel URL (${chalk.cyan(apiUrl.trim())}) domain is added under 'Authorized Domains' in your Google reCAPTCHA console.`
            );

            recaptchaPublicKey = await askValidated(rl, 'reCAPTCHA Public (Site) Key', '', (val) => {
                if (!val.trim()) return 'Public Key is required when reCAPTCHA is enabled';
            });
            recaptchaSecretKey = await askValidated(rl, 'reCAPTCHA Secret Key', '', (val) => {
                if (!val.trim()) return 'Secret Key is required when reCAPTCHA is enabled';
            });
        }

        const emailEnabled = await askConfirm(rl, 'Enable transactional email delivery (Resend)?', false);
        let resendApiKey = '';
        if (emailEnabled) {
            resendApiKey = await askValidated(rl, 'Resend API Key', '', (val) => {
                if (!val.trim()) return 'Resend API Key is required when enabled';
            });
        }

        displaySection('7. BILLING & PAYMENTS');

        const paymentsEnabled = await askConfirm(rl, 'Enable panel payment system?', true);
        let creditsPricePer10 = '0.2000';
        let providerOxaPayEnabled = false;
        let oxaPayApiKey = '';

        if (paymentsEnabled) {
            creditsPricePer10 = await ask(rl, 'Credit price per 10 credits (in USD)', '0.2000');
            providerOxaPayEnabled = await askConfirm(rl, 'Enable OxaPay crypto payment gateway?', false);
            if (providerOxaPayEnabled) {
                oxaPayApiKey = await askValidated(rl, 'Enter your OxaPay Merchant API Key (from Merchant Dashboard)', '', (val) => {
                    if (!val.trim()) return 'OxaPay Merchant API Key is required when enabled';
                });
            }
        }

        displaySection('8. API CALLBACKS & WEBHOOKS');

        const providerApiCallbackEnabled = await askConfirm(
            rl,
            'Enable external API Callbacks & Webhooks? (For adding credits by third-party apps)',
            false
        );

        let apiCallbackKey = '';
        if (providerApiCallbackEnabled) {
            const autoCallbackKey = generateRandomSecret(24);
            apiCallbackKey = await ask(rl, 'API Callback Authentication Key', autoCallbackKey);
        }

        const envContent = `# Cyrus Panel Configuration
# Generated on: ${new Date().toISOString()}

# API Server
BIND_IP=${bindIp.trim()}
PORT=${port.trim()}

# Config
API_URL=${apiUrl.trim()}
MONGO_URI=${mongoUri.trim()}
JWT_SECRET=${jwtSecret.trim()}

# Branding & Visuals
PANEL_NAME=${panelName.trim()}
PANEL_DESCRIPTION="${panelDescription.trim()}"
PANEL_ICON=${panelIcon.trim()}
ACCENT_COLOR="${accentColor.trim()}"
DEFAULT_MAX_DEPLOYMENTS=${defaultMaxDeployments.trim()}

# Verification & Mail
RECAPTCHA_ENABLED=${recaptchaEnabled}
RECAPTCHA_PUBLIC_KEY=${recaptchaPublicKey.trim()}
RECAPTCHA_SECRET_KEY=${recaptchaSecretKey.trim()}
EMAIL_ENABLED=${emailEnabled}
RESEND_API_KEY=${resendApiKey.trim()}

# Payments
PAYMENTS_ENABLED=${paymentsEnabled}
CREDITS_PRICE_PER_10=${creditsPricePer10.trim()}
PROVIDER_OXAPAY_ENABLED=${providerOxaPayEnabled}
OXAPAY_API_KEY=${oxaPayApiKey.trim()}

# Callback
PROVIDER_API_CALLBACK_ENABLED=${providerApiCallbackEnabled}
API_CALLBACK_KEY=${apiCallbackKey.trim()}

# Setup Marker
installationCompleted=true
`;

        fs.writeFileSync(envPath, envContent, 'utf8');

        console.log(chalk.white('\n─────────────────────────────────────────────────────────────'));
        console.log(chalk.green.bold('Setup completed successfully! Starting Cyrus Panel...\n'));

        rl.close();
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
        rl.close();
        throw err;
    }
}

async function checkAndRunSetup(envPath) {
    let isCompleted = false;

    if (fs.existsSync(envPath)) {
        try {
            const rawContent = fs.readFileSync(envPath, 'utf8');
            const parsed = dotenv.parse(rawContent);
            if (
                parsed.installationCompleted === 'true' ||
                parsed.INSTALATIONCOMPLETED === 'true' ||
                process.env.installationCompleted === 'true'
            ) {
                isCompleted = true;
            }
        } catch {}
    }

    if (!isCompleted) {
        console.clear();
        console.log(chalk.cyan.bold('\n┌─────────────────────────────────────────────────────────────┐'));
        console.log(chalk.cyan.bold('│                    CYRUS PANEL INSTALLER                    │'));
        console.log(chalk.cyan.bold('└─────────────────────────────────────────────────────────────┘\n'));
        console.log(chalk.yellow(' [!] No completed installation detected on this system.\n'));

        const rl = createPromptInterface();
        const shouldProceed = await askConfirm(rl, 'Would you like to begin the Cyrus Panel setup process now?', true);
        rl.close();

        if (!shouldProceed) {
            console.log(chalk.red('\n[!] Installation aborted. The server will not start.'));
            console.log(chalk.gray('Run this application again when you are ready to configure the panel.\n'));
            return new Promise(() => {});
        }

        await runInteractiveSetup(envPath);
    }
}

module.exports = { checkAndRunSetup };
