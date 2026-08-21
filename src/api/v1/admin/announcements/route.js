const { getDB } = require('../../../../lib/db');
const { authenticate } = require('../../../../lib/auth');
const { getPermissions } = require('../../../../lib/getPermissions');
const UploadHelper = require('../../../../lib/UploadHelper');
const { checkRateLimit } = require('../../../../lib/rateLimit');

function generateAnnouncementId() {
    return 'ann_' + Math.random().toString(36).substring(2, 10);
}

module.exports = {
    GET: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ANNOUNCEMENTS_GET', 60, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_ANNOUNCEMENTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_ANNOUNCEMENTS permission.' });
            }

            const { ann_id, id } = req.query || {};
            const targetId = ann_id || id;

            if (targetId) {
                const announcement = await db.collection('announcements').findOne({ id: targetId });
                if (!announcement) {
                    return reply.status(404).send({ error: 'Announcement not found.' });
                }
                return reply.status(200).send({ announcement });
            }

            const announcements = await db.collection('announcements')
                .find({})
                .sort({ createdAt: -1 })
                .toArray();

            const formatted = announcements.map(a => ({
                id: a.id || a._id.toString(),
                title: a.title,
                description: a.description,
                image: a.image || null,
                createdAt: a.createdAt,
                updatedAt: a.updatedAt || a.createdAt
            }));

            return reply.status(200).send({ announcements: formatted });
        } catch (err) {
            console.error('[Admin Announcements GET Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    POST: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ANNOUNCEMENTS_POST', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_ANNOUNCEMENTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_ANNOUNCEMENTS permission.' });
            }

            const annId = generateAnnouncementId();
            let title = '';
            let description = '';
            let imageUrl = null;
            let imageBase64 = null;

            if (req.isMultipart()) {
                const parts = req.parts();
                for await (const part of parts) {
                    if (part.type === 'file') {
                        if (part.fieldname === 'image') {
                            try {
                                imageUrl = await UploadHelper.uploadMultipartStream(part, 'announcements', annId);
                            } catch (uploadErr) {
                                return reply.status(400).send({ error: uploadErr.message || 'Image upload failed.' });
                            }
                        } else {
                            await part.toBuffer();
                        }
                    } else if (part.type === 'field') {
                        if (part.fieldname === 'title') title = part.value;
                        if (part.fieldname === 'description') description = part.value;
                    }
                }
            } else {
                const body = req.body || {};
                title = body.title || '';
                description = body.description || '';
                imageBase64 = body.image || null;
            }

            if (!title || typeof title !== 'string' || !title.trim()) {
                return reply.status(400).send({ error: 'Announcement title is required.' });
            }
            if (!description || typeof description !== 'string' || !description.trim()) {
                return reply.status(400).send({ error: 'Announcement description is required.' });
            }

            if (!imageUrl && imageBase64) {
                try {
                    imageUrl = await UploadHelper.uploadBase64Stream(imageBase64, 'announcements', annId);
                } catch (uploadErr) {
                    return reply.status(400).send({ error: uploadErr.message || 'Image upload failed.' });
                }
            }

            const newAnnouncement = {
                id: annId,
                title: title.trim(),
                description: description.trim(),
                image: imageUrl,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            await db.collection('announcements').insertOne(newAnnouncement);

            return reply.status(201).send({
                success: true,
                message: 'Announcement published successfully.',
                announcement: newAnnouncement
            });
        } catch (err) {
            console.error('[Admin Announcements POST Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    PUT: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ANNOUNCEMENTS_PUT', 30, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_ANNOUNCEMENTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_ANNOUNCEMENTS permission.' });
            }

            let id = '';
            let title = undefined;
            let description = undefined;
            let removeImage = false;
            let newUploadedImage = null;
            let imageBase64 = null;
            let imagePart = null;

            if (req.isMultipart()) {
                const parts = req.parts();
                for await (const part of parts) {
                    if (part.type === 'file') {
                        if (part.fieldname === 'image') {
                            const buffer = await part.toBuffer();
                            imagePart = {
                                file: buffer,
                                filename: part.filename,
                                mimetype: part.mimetype,
                                mime: part.mime
                            };
                        } else {
                            await part.toBuffer();
                        }
                    } else if (part.type === 'field') {
                        if (part.fieldname === 'id') id = part.value;
                        if (part.fieldname === 'title') title = part.value;
                        if (part.fieldname === 'description') description = part.value;
                        if (part.fieldname === 'removeImage') removeImage = part.value === 'true' || part.value === true;
                    }
                }
            } else {
                const body = req.body || {};
                id = body.id || '';
                title = body.title;
                description = body.description;
                removeImage = Boolean(body.removeImage);
                imageBase64 = body.image || null;
            }

            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Announcement ID is required.' });
            }

            const existing = await db.collection('announcements').findOne({ id });
            if (!existing) {
                return reply.status(404).send({ error: 'Announcement not found.' });
            }

            const updateDoc = { updatedAt: new Date().toISOString() };

            if (title !== undefined && typeof title === 'string') {
                updateDoc.title = title.trim();
            }
            if (description !== undefined && typeof description === 'string') {
                updateDoc.description = description.trim();
            }

            if (removeImage) {
                if (existing.image) {
                    UploadHelper.deleteOldAsset(existing.image, 'announcements');
                }
                updateDoc.image = null;
            } else if (imagePart) {
                try {
                    newUploadedImage = await UploadHelper.uploadMultipartStream(
                        imagePart,
                        'announcements',
                        id,
                        existing.image
                    );
                    if (newUploadedImage) updateDoc.image = newUploadedImage;
                } catch (uploadErr) {
                    return reply.status(400).send({ error: uploadErr.message || 'Image upload failed.' });
                }
            } else if (imageBase64) {
                try {
                    newUploadedImage = await UploadHelper.uploadBase64Stream(
                        imageBase64,
                        'announcements',
                        id,
                        existing.image
                    );
                    if (newUploadedImage) updateDoc.image = newUploadedImage;
                } catch (uploadErr) {
                    return reply.status(400).send({ error: uploadErr.message || 'Image upload failed.' });
                }
            }

            await db.collection('announcements').updateOne({ id }, { $set: updateDoc });

            return reply.status(200).send({
                success: true,
                message: 'Announcement updated successfully.'
            });
        } catch (err) {
            console.error('[Admin Announcements PUT Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    },
    DELETE: async (req, reply) => {
        try {
            await authenticate(req, reply);
            if (reply.sent) return;
            if (checkRateLimit(reply, req.userId, 'ADMIN_ANNOUNCEMENTS_DELETE', 20, 60000)) return;

            const db = getDB();
            const user = await db.collection('users').findOne({ _id: req.userId });
            if (!user) return reply.status(404).send({ error: 'User not found.' });

            const permissions = getPermissions(user);
            if (!permissions.includes('ADMIN_ANNOUNCEMENTS')) {
                return reply.status(403).send({ error: 'Forbidden: Requires ADMIN_ANNOUNCEMENTS permission.' });
            }

            const { id } = req.body || {};
            if (!id || typeof id !== 'string') {
                return reply.status(400).send({ error: 'Announcement ID is required.' });
            }

            const target = await db.collection('announcements').findOne({ id });
            if (!target) {
                return reply.status(404).send({ error: 'Announcement not found.' });
            }

            if (target.image) {
                UploadHelper.deleteOldAsset(target.image, 'announcements');
            }

            await db.collection('announcements').deleteOne({ id });

            return reply.status(200).send({
                success: true,
                message: 'Announcement deleted successfully.'
            });
        } catch (err) {
            console.error('[Admin Announcements DELETE Error]:', err);
            return reply.status(500).send({ error: 'Internal server error' });
        }
    }
};