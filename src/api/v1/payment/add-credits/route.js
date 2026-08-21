const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const { getDB } = require('../../../../lib/db');

const ENV_PATH = path.resolve(__dirname, '../../../../../.env');
const MAX_CREDITS = 999999999;

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};

    try {
        const content = fs.readFileSync(ENV_PATH, 'utf8');
        const envObj = {};

        content.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();

            if (trimmed && !trimmed.startsWith('#')) {
                const eqIdx = trimmed.indexOf('=');

                if (eqIdx !== -1) {
                    const key = trimmed.substring(0, eqIdx).trim();
                    let val = trimmed.substring(eqIdx + 1).trim();

                    if (
                        (val.startsWith('"') && val.endsWith('"')) ||
                        (val.startsWith("'") && val.endsWith("'"))
                    ) {
                        val = val.slice(1, -1);
                    }

                    envObj[key] = val;
                }
            }
        });

        return envObj;
    } catch {
        return {};
    }
}

module.exports = {
    POST: async (req, reply) => {
        try {
            const env = readEnvFile();

            const isCallbackEnabled =
                env.PROVIDER_API_CALLBACK_ENABLED === 'true';
            const validApiKey = env.API_CALLBACK_KEY;

            if (!isCallbackEnabled || !validApiKey) {
                return reply.status(403).send({
                    error: 'API Callback payment method is currently disabled.'
                });
            }

            const authHeader =
                req.headers.authorization || req.headers.Authorization;

            if (
                !authHeader ||
                !authHeader.startsWith('Bearer ')
            ) {
                return reply.status(401).send({
                    error: 'Unauthorized: Missing or invalid Authorization Bearer token header.'
                });
            }

            const incomingKey = authHeader.substring(7).trim();

            if (incomingKey !== validApiKey) {
                return reply.status(401).send({
                    error: 'Unauthorized: Invalid API key.'
                });
            }

            const body = req.body || {};
            const { identifier, amount } = body;

            if (
                !identifier ||
                typeof identifier !== 'string' ||
                !identifier.trim()
            ) {
                return reply.status(400).send({
                    error: 'Missing or invalid identifier. Provide an email, username, or userID.'
                });
            }

            const parsedAmount = Number(amount);

            if (
                !Number.isFinite(parsedAmount) ||
                parsedAmount <= 0
            ) {
                return reply.status(400).send({
                    error: 'Invalid amount. Must be a positive number of credits.'
                });
            }

            const cleanIdentifier = identifier.trim();
            const db = getDB();

            const escapedIdentifier = cleanIdentifier.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );

            const searchQueries = [
                {
                    email: new RegExp(`^${escapedIdentifier}$`, 'i')
                },
                {
                    username: new RegExp(`^${escapedIdentifier}$`, 'i')
                },
                {
                    _id: cleanIdentifier
                },
                {
                    id: cleanIdentifier
                }
            ];

            if (ObjectId.isValid(cleanIdentifier)) {
                try {
                    searchQueries.push({
                        _id: new ObjectId(cleanIdentifier)
                    });
                } catch {}
            }

            const targetUser = await db.collection('users').findOne({
                $or: searchQueries
            });

            if (!targetUser) {
                return reply.status(404).send({
                    error: `User not found for identifier: ${cleanIdentifier}`
                });
            }

            const currentCredits = Number(targetUser.credits) || 0;

            if (!Number.isFinite(currentCredits) || currentCredits < 0) {
                return reply.status(500).send({
                    error: 'User has an invalid credit balance.'
                });
            }

            if (currentCredits >= MAX_CREDITS) {
                return reply.status(400).send({
                    error: `User already has the maximum allowed balance of ${MAX_CREDITS} credits.`
                });
            }

            const remainingCredits = MAX_CREDITS - currentCredits;

            if (parsedAmount > remainingCredits) {
                return reply.status(400).send({
                    error: `Amount exceeds the maximum allowed balance of ${MAX_CREDITS} credits.`,
                    currentCredits,
                    requestedAmount: parsedAmount,
                    maximumCredits: MAX_CREDITS,
                    maximumAddable: remainingCredits
                });
            }

            const updatedResult = await db.collection('users').findOneAndUpdate(
                {
                    _id: targetUser._id,
                    credits: {
                        $gte: 0,
                        $lte: MAX_CREDITS - parsedAmount
                    }
                },
                {
                    $inc: {
                        credits: parsedAmount
                    }
                },
                {
                    returnDocument: 'after'
                }
            );

            const updatedUser = updatedResult.value || updatedResult;

            if (!updatedUser) {
                return reply.status(409).send({
                    error: 'Credit balance changed before the update could be completed. Please try again.'
                });
            }

            const newBalance = Number(updatedUser.credits);

            if (
                !Number.isFinite(newBalance) ||
                newBalance < 0 ||
                newBalance > MAX_CREDITS
            ) {
                console.error(
                    '[API Callback Add Credits Error]: Invalid post-update balance:',
                    newBalance
                );

                return reply.status(500).send({
                    error: 'Credit balance validation failed after update.'
                });
            }

            return reply.status(200).send({
                success: true,
                message: `Successfully added ${parsedAmount} credits to user ${targetUser.username}.`,
                user: {
                    id: targetUser._id,
                    username: targetUser.username,
                    email: targetUser.email,
                    credits: newBalance
                }
            });
        } catch (err) {
            console.error('[API Callback Add Credits Error]:', err);

            return reply.status(500).send({
                error: 'Internal server error processing credit addition.'
            });
        }
    }
};