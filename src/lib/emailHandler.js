const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

function getEnv() {
    const ENV_PATH = path.resolve(process.cwd(), '.env');
    let env = { ...process.env };
    if (fs.existsSync(ENV_PATH)) {
        try {
            const content = fs.readFileSync(ENV_PATH, 'utf8');
            content.split(/\r?\n/).forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx !== -1) {
                        const key = trimmed.substring(0, eqIdx).trim();
                        let val = trimmed.substring(eqIdx + 1).trim();
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            val = val.slice(1, -1);
                        }
                        env[key] = val;
                    }
                }
            });
        } catch (err) {
            console.error('[EmailHandler] Error reading .env file:', err);
        }
    }
    return env;
}

function generateEmailTemplate({
    title,
    preheader,
    greeting,
    message,
    buttonText,
    buttonUrl,
    footerText,
    accentColor,
    panelName
}) {
    const primaryColor = accentColor || '#00f2fe';
    const brandName = panelName || 'Cyrus Panel';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${title || brandName}</title>
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    body {
      margin: 0;
      padding: 0;
      width: 100% !important;
      background-color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .email-wrapper {
      width: 100%;
      background-color: #f4f4f5;
      padding: 40px 16px;
    }
    .email-container {
      max-width: 540px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #e4e4e7;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);
    }
    .header-bar {
      height: 6px;
      background-color: ${primaryColor};
      width: 100%;
    }
    .content-padding {
      padding: 40px 32px;
    }
    .brand-title {
      font-size: 22px;
      font-weight: 800;
      color: #09090b;
      margin: 0 0 24px 0;
      text-align: center;
      letter-spacing: -0.5px;
    }
    .greeting-text {
      font-size: 18px;
      font-weight: 700;
      color: #18181b;
      margin: 0 0 16px 0;
    }
    .message-text {
      font-size: 15px;
      line-height: 1.6;
      color: #52525b;
      margin: 0 0 28px 0;
    }
    .button-container {
      text-align: center;
      margin: 32px 0;
    }
    .btn {
      display: inline-block;
      background-color: ${primaryColor};
      color: #09090b !important;
      font-weight: 700;
      font-size: 15px;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .divider {
      border-top: 1px solid #f4f4f5;
      margin: 32px 0 24px 0;
    }
    .footer-subtext {
      font-size: 13px;
      line-height: 1.5;
      color: #a1a1aa;
      text-align: center;
      margin: 0;
    }
    .copyright {
      text-align: center;
      font-size: 12px;
      color: #a1a1aa;
      margin-top: 24px;
    }
    @media (prefers-color-scheme: dark) {
      body, .email-wrapper {
        background-color: #09090b !important;
      }
      .email-container {
        background-color: #121318 !important;
        border-color: #27272a !important;
      }
      .brand-title, .greeting-text {
        color: #ffffff !important;
      }
      .message-text {
        color: #a1a1aa !important;
      }
      .divider {
        border-top-color: #27272a !important;
      }
      .footer-subtext, .copyright {
        color: #71717a !important;
      }
    }
  </style>
</head>
<body>
  ${preheader ? `<div style="display:none;font-size:1px;color:#333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader}</div>` : ''}
  <div class="email-wrapper">
    <div class="email-container">
      <div class="header-bar"></div>
      <div class="content-padding">
        <h1 class="brand-title">${brandName}</h1>
        ${greeting ? `<div class="greeting-text">${greeting}</div>` : ''}
        <div class="message-text">${message}</div>
        ${buttonText && buttonUrl ? `
          <div class="button-container">
            <a href="${buttonUrl}" target="_blank" class="btn">${buttonText}</a>
          </div>
        ` : ''}
        <div class="divider"></div>
        ${footerText ? `<p class="footer-subtext">${footerText}</p>` : ''}
      </div>
    </div>
    <div class="copyright">&copy; ${new Date().getFullYear()} ${brandName}. All rights reserved.</div>
  </div>
</body>
</html>
    `;
}

async function sendEmail({ to, subject, html, options = {} }) {
    const env = getEnv();
    const isEnabled = env.EMAIL_ENABLED === 'true';
    const apiKey = env.RESEND_API_KEY;

    if (!isEnabled || !apiKey) {
        console.log(`[EmailHandler] Email skipped (EMAIL_ENABLED=${isEnabled}, API Key present=${!!apiKey})`);
        return { success: false, reason: 'Email service is disabled or unconfigured' };
    }

    try {
        const resend = new Resend(apiKey);
        const panelName = env.PANEL_NAME || 'Cyrus Panel';
        const fromEmail = env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
        const sender = `${panelName} <${fromEmail}>`;

        const data = await resend.emails.send({
            from: sender,
            to,
            subject,
            html,
            ...options
        });

        return { success: true, data };
    } catch (err) {
        console.error('[EmailHandler Error]:', err);
        return { success: false, error: err.message || err };
    }
}

async function sendPasswordResetEmail({ to, username, resetUrl }) {
    const env = getEnv();
    const panelName = env.PANEL_NAME || 'Cyrus Panel';
    const accentColor = env.ACCENT_COLOR || '#00f2fe';

    const html = generateEmailTemplate({
        title: `Reset your ${panelName} password`,
        preheader: `Use this link to reset your ${panelName} account password.`,
        greeting: `Hello ${username},`,
        message: `We received a request to reset the password for your account on <strong>${panelName}</strong>. Click the button below to choose a new password.`,
        buttonText: 'Reset Password',
        buttonUrl: resetUrl,
        footerText: `If you didn't request a password reset, you can safely ignore this email.<br>This link will expire in 24 hours.`,
        accentColor,
        panelName
    });

    return sendEmail({
        to,
        subject: `Reset your ${panelName} Password`,
        html
    });
}

async function sendVerificationEmail({ to, username, verifyUrl }) {
    const env = getEnv();
    const panelName = env.PANEL_NAME || 'Cyrus Panel';
    const accentColor = env.ACCENT_COLOR || '#00f2fe';

    const html = generateEmailTemplate({
        title: `Verify your email address for ${panelName}`,
        preheader: `Confirm your email address to access your ${panelName} account.`,
        greeting: `Welcome, ${username}!`,
        message: `Thank you for creating an account on <strong>${panelName}</strong>. Please confirm your email address by clicking the button below.`,
        buttonText: 'Verify Email Address',
        buttonUrl: verifyUrl,
        footerText: `If you did not create an account on ${panelName}, you can safely disregard this message.<br>This link will expire in 24 hours.`,
        accentColor,
        panelName
    });

    return sendEmail({
        to,
        subject: `Verify your ${panelName} Email Address`,
        html
    });
}

module.exports = {
    getEnv,
    generateEmailTemplate,
    sendEmail,
    sendPasswordResetEmail,
    sendVerificationEmail
};