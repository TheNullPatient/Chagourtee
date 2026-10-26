const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const ffmpeg = require('fluent-ffmpeg');

// Directory for storing encrypted media files.
// CHAGOURTEE_MEDIA_DIR exists so tests can use an isolated directory.
const MEDIA_DIR = process.env.CHAGOURTEE_MEDIA_DIR
    ? path.resolve(process.env.CHAGOURTEE_MEDIA_DIR)
    : path.join(__dirname, '../data/media');

// Encrypted file layout: [IV 16 bytes][GCM auth tag 16 bytes][ciphertext]
const MEDIA_HEADER_SIZE = 32;
const MEDIA_IV_SIZE = 16;
const MEDIA_AUTH_TAG_SIZE = 16;

// Configure ffmpeg/fluent-ffmpeg binaries
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// TTL for cached audio transcodes (in ms). 0 or negative means infinite (until message deletion).
const AUDIO_TRANSCODE_TTL_MS = (() => {
    const days = parseInt(process.env.CHAGOURTEE_AUDIO_TRANSCODE_TTL_DAYS || '0', 10);
    if (!Number.isFinite(days) || days <= 0) return 0;
    return days * 24 * 60 * 60 * 1000;
})();

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/**
 * Generates a unique filename for encrypted media
 */
function generateEncryptedFilename(originalName) {
    const ext = path.extname(originalName);
    const base = path.basename(originalName, ext);
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    
    return `${base}_${timestamp}_${randomString}.enc`;
}

/**
 * Reads the AES-GCM header of an encrypted media file.
 */
function readEncryptedFileHeader(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(MEDIA_HEADER_SIZE);
        const bytesRead = fs.readSync(fd, header, 0, MEDIA_HEADER_SIZE, 0);
        if (bytesRead < MEDIA_HEADER_SIZE) {
            throw new Error('Invalid media file: truncated header');
        }
        const stat = fs.fstatSync(fd);
        return {
            iv: header.subarray(0, MEDIA_IV_SIZE),
            authTag: header.subarray(
                MEDIA_IV_SIZE,
                MEDIA_IV_SIZE + MEDIA_AUTH_TAG_SIZE
            ),
            plaintextSize: Math.max(0, stat.size - MEDIA_HEADER_SIZE),
        };
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Returns the configured 32-byte media encryption key.
 */
function getMediaEncryptionKey() {
    const encryptionKey = process.env.CHAGOURTEE_MEDIA_ENCRYPTION_KEY;
    if (!encryptionKey) {
        throw new Error('Encryption key not configured');
    }
    const keyBuffer = Buffer.from(encryptionKey, 'hex');
    if (keyBuffer.length !== 32) {
        throw new Error('Invalid encryption key configuration');
    }
    return keyBuffer;
}

async function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error && error.code !== 'ENOENT') {
            console.error(`Failed to delete ${filePath}:`, error);
        }
    }
}

/**
 * Encrypts a readable stream into an AES-256-GCM media file without ever
 * holding the whole upload in memory.
 * Returns the plaintext byte count.
 */
async function encryptStreamToFile(sourceStream, destinationPath, key) {
    const iv = crypto.randomBytes(MEDIA_IV_SIZE);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const output = fs.createWriteStream(destinationPath, { flags: 'wx' });
    // Reserve space for the IV and auth tag; both are written once the cipher
    // has finished and the authentication tag exists.
    output.write(Buffer.alloc(MEDIA_HEADER_SIZE));

    let size = 0;
    const byteCounter = new Transform({
        transform(chunk, encoding, callback) {
            size += chunk.length;
            callback(null, chunk);
        },
    });

    try {
        await pipeline(sourceStream, byteCounter, cipher, output);
    } catch (error) {
        output.destroy();
        await safeUnlink(destinationPath);
        throw error;
    }

    const authTag = cipher.getAuthTag();
    const handle = await fs.promises.open(destinationPath, 'r+');
    try {
        await handle.write(iv, 0, iv.length, 0);
        await handle.write(authTag, 0, authTag.length, MEDIA_IV_SIZE);
    } finally {
        await handle.close();
    }

    return size;
}

/**
 * Decrypts an encrypted media file into a plaintext file on disk.
 */
async function decryptFileToFile(encryptedPath, destinationPath, key) {
    const { iv, authTag } = readEncryptedFileHeader(encryptedPath);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    try {
        await pipeline(
            fs.createReadStream(encryptedPath, { start: MEDIA_HEADER_SIZE }),
            decipher,
            fs.createWriteStream(destinationPath)
        );
    } catch (error) {
        await safeUnlink(destinationPath);
        throw error;
    }
}

/**
 * Creates a readable stream with plaintext bytes [start, end] (inclusive).
 *
 * AES-GCM has to process the ciphertext from the beginning to produce a block,
 * so for Range requests the prefix is decrypted and discarded. Memory usage
 * stays bounded by the stream high-water mark.
 *
 * The auth tag is verified only when the complete plaintext is requested.
 */
function createDecryptedRangeStream(filePath, header, key, start, end) {
    const input = fs.createReadStream(filePath, {
        start: MEDIA_HEADER_SIZE,
        end: MEDIA_HEADER_SIZE + end,
    });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.iv);
    decipher.setAuthTag(header.authTag);

    const isWholeFile = start === 0 && end === header.plaintextSize - 1;
    let toSkip = start;

    async function* generate() {
        try {
            for await (const chunk of input) {
                let plaintext = decipher.update(chunk);
                if (plaintext.length === 0) continue;

                if (toSkip > 0) {
                    if (plaintext.length <= toSkip) {
                        toSkip -= plaintext.length;
                        continue;
                    }
                    plaintext = plaintext.subarray(toSkip);
                    toSkip = 0;
                }

                yield plaintext;
            }

            if (isWholeFile) {
                const finalChunk = decipher.final();
                if (finalChunk.length > 0) yield finalChunk;
            }
        } finally {
            input.destroy();
        }
    }

    return Readable.from(generate());
}

/**
 * Checks if a file type is allowed
 */
function isFileTypeAllowed(mimeType, originalName) {
    // Allow all file types - no restriction
    return true;
}

/**
 * Analyze audio codec using ffprobe.
 * Expects a plaintext audio file on disk.
 */
function analyzeAudioCodec(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(filePath)
            .ffprobe((err, data) => {
                if (err) {
                    return reject(err);
                }

                const audioStream =
                    (data.streams || []).find((s) => s.codec_type === 'audio') || null;

                resolve({
                    codecName: audioStream ? audioStream.codec_name : null,
                    sampleRate: audioStream ? Number(audioStream.sample_rate) || null : null,
                    channels: audioStream ? audioStream.channels || null : null,
                    formatName: data.format ? data.format.format_name : null,
                });
            });
    });
}

/**
 * Decide whether we should transcode given codec into FLAC.
 * We mainly target ALAC and AIFF/PCM big-endian, which are problematic for browsers.
 */
function shouldTranscodeToFlac(codecName, mimeType, originalName) {
    const lowerCodec = (codecName || '').toLowerCase();
    const lowerMime = (mimeType || '').toLowerCase();
    const lowerName = (originalName || '').toLowerCase();

    // Obvious problematic containers/extensions
    if (lowerMime.includes('aiff') || lowerMime.includes('aif')) return true;
    if (lowerName.endsWith('.aif') || lowerName.endsWith('.aiff')) return true;

    // Apple Lossless
    if (lowerCodec === 'alac') return true;

    // Big-endian PCM from AIFF or similar
    if (lowerCodec.startsWith('pcm_s') && lowerCodec.endsWith('be')) return true;

    // Known browser-friendly codecs we do NOT want to touch
    if (lowerCodec === 'aac') return false;
    if (lowerCodec === 'mp3') return false;
    if (lowerCodec === 'vorbis') return false;
    if (lowerCodec === 'opus') return false;

    // For m4a/aac containers, let them pass by default
    if (lowerMime === 'audio/aac' || lowerMime === 'audio/mp4' || lowerName.endsWith('.m4a')) {
        return false;
    }

    // Default: no transcode unless strongly suspicious
    return false;
}

/**
 * Registers the media plugin with Fastify
 */
async function mediaPlugin(fastify, options) {
    // Register multipart for handling file uploads
    await fastify.register(require('fastify-multipart'), {
        limits: {
            fields: 10,
            files: 1
        }
    });

    const db = fastify.db;
    // 0 = disable uploads, -1 = unlimited, >0 = bytes limit
    const envUploadLimitRaw = parseInt(process.env.CHAGOURTEE_MAX_FILE_SIZE || '52428800', 10);
    const envUploadLimit =
        Number.isFinite(envUploadLimitRaw) && envUploadLimitRaw >= -1 ? envUploadLimitRaw : 52428800;
    // 0 = unlimited, >0 = bytes limit
    const envStorageLimitRaw = parseInt(process.env.CHAGOURTEE_MAX_STORAGE_SIZE || '0', 10);
    const envStorageLimit =
        Number.isFinite(envStorageLimitRaw) && envStorageLimitRaw >= 0 ? envStorageLimitRaw : 0;
    const envCleanupStrategy =
        process.env.CHAGOURTEE_STORAGE_CLEANUP_STRATEGY === 'delete_oldest'
            ? 'delete_oldest'
            : 'block';
    const envOrphanCleanupEnabled = process.env.CHAGOURTEE_ORPHAN_MEDIA_CLEANUP_ENABLED === 'false' ? 0 : 1;
    const envOrphanCleanupInterval = Math.max(
        1,
        parseInt(process.env.CHAGOURTEE_ORPHAN_MEDIA_CLEANUP_INTERVAL_MINUTES || '60', 10) || 60
    );
    const envOrphanCleanupGrace = Math.max(
        1,
        parseInt(process.env.CHAGOURTEE_ORPHAN_MEDIA_CLEANUP_GRACE_MINUTES || '10', 10) || 10
    );

    function ensureMediaSettingsRow() {
        const existing = db.prepare('SELECT id FROM media_storage_settings WHERE id = 1').get();
        if (existing) return;
        const now = new Date().toISOString();
        db.prepare(
            `
            INSERT INTO media_storage_settings (
                id,
                max_file_size,
                max_storage_size,
                cleanup_strategy,
                orphan_cleanup_enabled,
                orphan_cleanup_interval_minutes,
                orphan_cleanup_grace_minutes,
                created_at,
                updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            envUploadLimit,
            envStorageLimit,
            envCleanupStrategy,
            envOrphanCleanupEnabled,
            envOrphanCleanupInterval,
            envOrphanCleanupGrace,
            now,
            now
        );
    }

    ensureMediaSettingsRow();

    function getStorageSettings() {
        const row = db
            .prepare(
                `
                SELECT
                    max_file_size,
                    max_storage_size,
                    cleanup_strategy,
                    orphan_cleanup_enabled,
                    orphan_cleanup_interval_minutes,
                    orphan_cleanup_grace_minutes
                FROM media_storage_settings
                WHERE id = 1
            `
            )
            .get();

        const cleanupStrategy =
            row && row.cleanup_strategy === 'delete_oldest'
                ? 'delete_oldest'
                : row && row.cleanup_strategy === 'block'
                    ? 'block'
                    : envCleanupStrategy;

        let maxStorageSize = envStorageLimit;
        if (row && typeof row.max_storage_size === 'number') {
            maxStorageSize = row.max_storage_size;
        }

        let maxFileSize = envUploadLimit;
        if (row && typeof row.max_file_size === 'number') {
            maxFileSize = row.max_file_size;
        }

        const orphanCleanupEnabled =
            row && typeof row.orphan_cleanup_enabled === 'number'
                ? row.orphan_cleanup_enabled === 1
                : envOrphanCleanupEnabled === 1;
        const orphanCleanupIntervalMinutes =
            row && typeof row.orphan_cleanup_interval_minutes === 'number'
                ? Math.max(1, row.orphan_cleanup_interval_minutes)
                : envOrphanCleanupInterval;
        const orphanCleanupGraceMinutes =
            row && typeof row.orphan_cleanup_grace_minutes === 'number'
                ? Math.max(1, row.orphan_cleanup_grace_minutes)
                : envOrphanCleanupGrace;

        return {
            maxFileSize,
            maxStorageSize,
            cleanupStrategy,
            orphanCleanupEnabled,
            orphanCleanupIntervalMinutes,
            orphanCleanupGraceMinutes,
        };
    }

    function getUploadSettings() {
        const settings = getStorageSettings();
        const raw = settings.maxFileSize;
        return {
            uploadsEnabled: raw !== 0,
            unlimited: raw === -1,
            maxFileSize: raw > 0 ? raw : null,
            rawMaxFileSize: raw,
        };
    }

    function getCurrentStorageUsage() {
        const row = db
            .prepare('SELECT COALESCE(SUM(file_size), 0) AS total, COUNT(*) AS files FROM media_files')
            .get();
        return {
            totalBytes: Number(row?.total || 0),
            filesCount: Number(row?.files || 0),
        };
    }

    function removeMediaById(mediaId) {
        const media = db
            .prepare(
                `
                SELECT id, encrypted_filename, transcoded_filename
                FROM media_files
                WHERE id = ?
            `
            )
            .get(mediaId);

        if (!media) return false;

        const originalPath = path.join(MEDIA_DIR, media.encrypted_filename);
        if (fs.existsSync(originalPath)) {
            try {
                fs.unlinkSync(originalPath);
            } catch (e) {
                fastify.log.error(`Failed to delete media file ${originalPath}:`, e);
            }
        }

        if (media.transcoded_filename) {
            const transcodedPath = path.join(MEDIA_DIR, media.transcoded_filename);
            if (fs.existsSync(transcodedPath)) {
                try {
                    fs.unlinkSync(transcodedPath);
                } catch (e) {
                    fastify.log.error(`Failed to delete transcoded media file ${transcodedPath}:`, e);
                }
            }
        }

        db.prepare('DELETE FROM media_files WHERE id = ?').run(media.id);
        if (typeof fastify.broadcastAll === 'function') {
            fastify.broadcastAll({ type: 'media_removed', mediaId: media.id });
        }
        return true;
    }

    function cleanupOldestMedia(bytesToFree) {
        if (bytesToFree <= 0) {
            return { deletedFiles: 0, freedBytes: 0 };
        }

        const candidates = db
            .prepare(
                `
                SELECT id, file_size
                FROM media_files
                ORDER BY datetime(created_at) ASC, id ASC
            `
            )
            .all();

        let freedBytes = 0;
        let deletedFiles = 0;

        for (const file of candidates) {
            if (freedBytes >= bytesToFree) break;
            const deleted = removeMediaById(file.id);
            if (deleted) {
                freedBytes += Number(file.file_size || 0);
                deletedFiles += 1;
            }
        }

        return { deletedFiles, freedBytes };
    }

    function cleanupOrphanedMedia() {
        const settings = getStorageSettings();
        if (!settings.orphanCleanupEnabled) {
            return { deletedFiles: 0, freedBytes: 0 };
        }

        const olderThan = `-${settings.orphanCleanupGraceMinutes} minutes`;
        const candidates = db
            .prepare(
                `
                SELECT id, file_size
                FROM media_files
                WHERE message_id IS NULL
                  AND datetime(created_at) <= datetime('now', ?)
                ORDER BY datetime(created_at) ASC, id ASC
            `
            )
            .all(olderThan);

        let deletedFiles = 0;
        let freedBytes = 0;
        for (const file of candidates) {
            // Safety check: only remove rows still orphaned at the deletion moment.
            const latest = db
                .prepare('SELECT id, message_id FROM media_files WHERE id = ?')
                .get(file.id);
            if (!latest || latest.message_id !== null) continue;

            const deleted = removeMediaById(file.id);
            if (deleted) {
                deletedFiles += 1;
                freedBytes += Number(file.file_size || 0);
            }
        }

        if (deletedFiles > 0) {
            fastify.log.info(
                `Orphan media cleanup: deleted ${deletedFiles} files, freed ${freedBytes} bytes`
            );
        }

        return { deletedFiles, freedBytes };
    }

    let lastOrphanCleanupAt = 0;
    const orphanCleanupScheduler = setInterval(() => {
        try {
            const settings = getStorageSettings();
            if (!settings.orphanCleanupEnabled) return;
            const intervalMs = settings.orphanCleanupIntervalMinutes * 60 * 1000;
            const now = Date.now();
            if (now - lastOrphanCleanupAt < intervalMs) return;
            lastOrphanCleanupAt = now;
            cleanupOrphanedMedia();
        } catch (e) {
            fastify.log.error('Failed to run orphan media cleanup:', e);
        }
    }, 60 * 1000);
    orphanCleanupScheduler.unref();

    fastify.addHook('onClose', (_instance, done) => {
        clearInterval(orphanCleanupScheduler);
        done();
    });

    /**
     * Ensure we have a FLAC transcode for problematic audio.
     * Returns object describing which encrypted file and mime type to serve.
     */
    async function ensureFlacTranscode(mediaFile) {
        const keyBuffer = getMediaEncryptionKey();
        const now = Date.now();

        // If we have existing transcode, check TTL
        if (mediaFile.transcoded_filename) {
            const createdAt = typeof mediaFile.transcoded_created_at === 'number'
                ? mediaFile.transcoded_created_at
                : null;

            const isExpired =
                AUDIO_TRANSCODE_TTL_MS > 0 &&
                createdAt !== null &&
                createdAt + AUDIO_TRANSCODE_TTL_MS < now;

            if (!isExpired) {
                const filePath = path.join(MEDIA_DIR, mediaFile.transcoded_filename);
                if (fs.existsSync(filePath)) {
                    return {
                        encryptedFilenameToServe: mediaFile.transcoded_filename,
                        mimeTypeToServe: mediaFile.transcoded_mime_type || 'audio/flac',
                        isTranscoded: true,
                    };
                }
            } else {
                // Delete expired transcode from disk if still present
                const filePath = path.join(MEDIA_DIR, mediaFile.transcoded_filename);
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (e) {
                        fastify.log.error(
                            `Failed to delete expired transcoded media file ${filePath}:`,
                            e
                        );
                    }
                }
                // Clear metadata; will be re-created below if needed
                db.prepare(
                    `
                    UPDATE media_files
                    SET transcoded_filename = NULL,
                        transcoded_mime_type = NULL,
                        transcoded_created_at = NULL
                    WHERE id = ?
                `
                ).run(mediaFile.id);
                mediaFile.transcoded_filename = null;
                mediaFile.transcoded_mime_type = null;
                mediaFile.transcoded_created_at = null;
            }
        }

        const originalResult = {
            encryptedFilenameToServe: mediaFile.encrypted_filename,
            mimeTypeToServe: mediaFile.mime_type,
            isTranscoded: false,
        };

        const tmpDir = os.tmpdir();
        const safeBase =
            path
                .basename(mediaFile.original_name || 'audio', path.extname(mediaFile.original_name || '')) ||
            'audio';
        const tmpSuffix = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const tmpInput = path.join(tmpDir, `${safeBase}_${tmpSuffix}_in`);
        const tmpOutput = path.join(tmpDir, `${safeBase}_${tmpSuffix}_out.flac`);

        try {
            const encryptedPath = path.join(MEDIA_DIR, mediaFile.encrypted_filename);
            if (!fs.existsSync(encryptedPath)) {
                throw new Error('File not found on disk');
            }

            // Decrypt to a temporary plaintext file so ffmpeg/ffprobe can work
            // on it without loading the whole file into memory.
            await decryptFileToFile(encryptedPath, tmpInput, keyBuffer);

            let codecInfo;
            try {
                codecInfo = await analyzeAudioCodec(tmpInput);
            } catch (e) {
                fastify.log.error(
                    'Failed to analyze audio codec for media file',
                    mediaFile.id,
                    e
                );
                return originalResult;
            }

            const needTranscode = shouldTranscodeToFlac(
                codecInfo.codecName,
                mediaFile.mime_type,
                mediaFile.original_name
            );

            if (!needTranscode) {
                return originalResult;
            }

            // Perform transcode to FLAC using ffmpeg
            try {
                await new Promise((resolve, reject) => {
                    ffmpeg(tmpInput)
                        .toFormat('flac')
                        .on('error', (err) => {
                            reject(err);
                        })
                        .on('end', () => {
                            resolve();
                        })
                        .save(tmpOutput);
                });
            } catch (err) {
                fastify.log.error(
                    'Failed to transcode audio to FLAC for media file',
                    mediaFile.id,
                    err
                );
                return originalResult;
            }

            const flacEncryptedFilename = generateEncryptedFilename(
                `${mediaFile.original_name}.flac`
            );
            const flacEncryptedPath = path.join(MEDIA_DIR, flacEncryptedFilename);
            const tempEncryptedPath = `${flacEncryptedPath}.part`;

            try {
                await encryptStreamToFile(
                    fs.createReadStream(tmpOutput),
                    tempEncryptedPath,
                    keyBuffer
                );
                await fs.promises.rename(tempEncryptedPath, flacEncryptedPath);
            } catch (err) {
                await safeUnlink(tempEncryptedPath);
                throw err;
            }

            const createdAt = Date.now();
            try {
                db.prepare(
                    `
                    UPDATE media_files
                    SET transcoded_filename = ?,
                        transcoded_mime_type = ?,
                        transcoded_created_at = ?
                    WHERE id = ?
                `
                ).run(flacEncryptedFilename, 'audio/flac', createdAt, mediaFile.id);
            } catch (err) {
                await safeUnlink(flacEncryptedPath);
                throw err;
            }

            mediaFile.transcoded_filename = flacEncryptedFilename;
            mediaFile.transcoded_mime_type = 'audio/flac';
            mediaFile.transcoded_created_at = createdAt;

            return {
                encryptedFilenameToServe: flacEncryptedFilename,
                mimeTypeToServe: 'audio/flac',
                isTranscoded: true,
            };
        } catch (err) {
            fastify.log.error(
                'Failed to prepare audio media file',
                mediaFile.id,
                err
            );
            return originalResult;
        } finally {
            await safeUnlink(tmpInput);
            await safeUnlink(tmpOutput);
        }
    }

    fastify.get(
        '/api/media/settings',
        {
            preHandler: [fastify.requireAuth],
        },
        async () => {
            const uploadSettings = getUploadSettings();
            const storageSettings = getStorageSettings();
            return {
                uploadsEnabled: uploadSettings.uploadsEnabled,
                unlimited: uploadSettings.unlimited,
                maxFileSize: uploadSettings.maxFileSize,
                storage: {
                    maxStorageSize: storageSettings.maxStorageSize,
                    cleanupStrategy: storageSettings.cleanupStrategy,
                },
            };
        }
    );

    fastify.get(
        '/api/media/storage-settings',
        {
            preHandler: [fastify.requireAuth, fastify.requireOwner],
        },
        async () => {
            const usage = getCurrentStorageUsage();
            const settings = getStorageSettings();
            return {
                maxFileSize: settings.maxFileSize,
                maxStorageSize: settings.maxStorageSize,
                cleanupStrategy: settings.cleanupStrategy,
                orphanCleanupEnabled: settings.orphanCleanupEnabled,
                orphanCleanupIntervalMinutes: settings.orphanCleanupIntervalMinutes,
                orphanCleanupGraceMinutes: settings.orphanCleanupGraceMinutes,
                totalBytes: usage.totalBytes,
                filesCount: usage.filesCount,
            };
        }
    );

    fastify.post(
        '/api/media/storage-settings',
        {
            preHandler: [fastify.requireAuth, fastify.requireOwner],
        },
        async (req, reply) => {
            const body = req.body || {};
            const cleanupStrategy =
                body.cleanupStrategy === 'delete_oldest' ? 'delete_oldest' : 'block';
            const requestedMaxFileSize =
                body.maxFileSize === null || body.maxFileSize === undefined
                    ? null
                    : Number(body.maxFileSize);
            const requestedMaxStorageSize =
                body.maxStorageSize === null || body.maxStorageSize === undefined
                    ? null
                    : Number(body.maxStorageSize);
            const orphanCleanupEnabled = body.orphanCleanupEnabled === false ? 0 : 1;
            const orphanCleanupIntervalMinutes = Math.max(
                1,
                Number(body.orphanCleanupIntervalMinutes || 60)
            );
            const orphanCleanupGraceMinutes = Math.max(
                1,
                Number(body.orphanCleanupGraceMinutes || 10)
            );

            if (
                requestedMaxFileSize !== null &&
                (!Number.isFinite(requestedMaxFileSize) || requestedMaxFileSize < -1)
            ) {
                return reply.code(400).send({ error: 'Invalid maxFileSize' });
            }

            if (
                requestedMaxStorageSize !== null &&
                (!Number.isFinite(requestedMaxStorageSize) || requestedMaxStorageSize < 0)
            ) {
                return reply.code(400).send({ error: 'Invalid maxStorageSize' });
            }

            const now = new Date().toISOString();
            const existing = db.prepare('SELECT id FROM media_storage_settings WHERE id = 1').get();
            if (existing) {
                db.prepare(
                    `
                    UPDATE media_storage_settings
                    SET max_file_size = ?,
                        max_storage_size = ?,
                        cleanup_strategy = ?,
                        orphan_cleanup_enabled = ?,
                        orphan_cleanup_interval_minutes = ?,
                        orphan_cleanup_grace_minutes = ?,
                        updated_at = ?
                    WHERE id = 1
                `
                ).run(
                    requestedMaxFileSize,
                    requestedMaxStorageSize,
                    cleanupStrategy,
                    orphanCleanupEnabled,
                    orphanCleanupIntervalMinutes,
                    orphanCleanupGraceMinutes,
                    now
                );
            } else {
                db.prepare(
                    `
                    INSERT INTO media_storage_settings (
                        id,
                        max_file_size,
                        max_storage_size,
                        cleanup_strategy,
                        orphan_cleanup_enabled,
                        orphan_cleanup_interval_minutes,
                        orphan_cleanup_grace_minutes,
                        created_at,
                        updated_at
                    )
                    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
                `
                ).run(
                    requestedMaxFileSize,
                    requestedMaxStorageSize,
                    cleanupStrategy,
                    orphanCleanupEnabled,
                    orphanCleanupIntervalMinutes,
                    orphanCleanupGraceMinutes,
                    now,
                    now
                );
            }

            const usage = getCurrentStorageUsage();
            return {
                maxFileSize: requestedMaxFileSize,
                maxStorageSize: requestedMaxStorageSize,
                cleanupStrategy,
                orphanCleanupEnabled: orphanCleanupEnabled === 1,
                orphanCleanupIntervalMinutes,
                orphanCleanupGraceMinutes,
                totalBytes: usage.totalBytes,
                filesCount: usage.filesCount,
            };
        }
    );

    // Endpoint for uploading media files
    fastify.post('/api/upload', {
        preHandler: [fastify.requireAuth]
    }, async (req, reply) => {
        let tempPath = null;
        let finalPath = null;
        let fileCommitted = false;

        try {
            const uploadSettings = getUploadSettings();
            if (!uploadSettings.uploadsEnabled) {
                return reply.code(403).send({
                    error: 'Media upload is disabled',
                    code: 'MEDIA_UPLOAD_DISABLED',
                });
            }

            if (!req.isMultipart()) {
                return reply.code(400).send({ error: 'Expected a multipart/form-data request' });
            }

            // Enforce the per-request limit while the file is being streamed.
            // `throwFileSizeLimit: false` lets us return a consistent JSON error
            // instead of relying on the multipart plugin's exception.
            const fileSizeLimit =
                !uploadSettings.unlimited && uploadSettings.maxFileSize > 0
                    ? uploadSettings.maxFileSize
                    : undefined;

            const data = await req.file({
                limits: fileSizeLimit ? { fileSize: fileSizeLimit } : undefined,
                throwFileSizeLimit: false,
            });

            if (!data) {
                return reply.code(400).send({ error: 'No file uploaded' });
            }

            // Override MIME type for .aif/.aiff to treat as documents
            let mimeTypeToUse = data.mimetype;
            const lowerName = data.filename.toLowerCase();
            if (lowerName.endsWith('.aif') || lowerName.endsWith('.aiff')) {
                mimeTypeToUse = 'application/octet-stream';
            }

            // Check file type with potentially overridden MIME type
            if (!isFileTypeAllowed(mimeTypeToUse, data.filename)) {
                return reply.code(400).send({ error: 'File type not allowed' });
            }

            let keyBuffer;
            try {
                keyBuffer = getMediaEncryptionKey();
            } catch (error) {
                console.error('Media encryption is not configured correctly:', error.message);
                return reply.code(500).send({ error: error.message });
            }

            const encryptedFilename = generateEncryptedFilename(data.filename);
            finalPath = path.join(MEDIA_DIR, encryptedFilename);
            tempPath = `${finalPath}.part`;

            // Stream the upload through AES-GCM into a temporary file. The whole
            // file is never buffered in memory.
            let uploadedBytes;
            try {
                uploadedBytes = await encryptStreamToFile(data.file, tempPath, keyBuffer);
            } catch (error) {
                await safeUnlink(tempPath);
                throw error;
            }

            if (
                data.file.truncated ||
                (fileSizeLimit !== undefined && uploadedBytes > fileSizeLimit)
            ) {
                await safeUnlink(tempPath);
                return reply.code(413).send({
                    error: 'File too large',
                    code: 'MEDIA_FILE_TOO_LARGE',
                    maxFileSize: uploadSettings.maxFileSize,
                });
            }

            // Enforce total media storage quota
            const storageSettings = getStorageSettings();
            const storageLimit = storageSettings.maxStorageSize;
            if (storageLimit > 0) {
                const usage = getCurrentStorageUsage();
                const projectedTotal = usage.totalBytes + uploadedBytes;
                if (projectedTotal > storageLimit) {
                    if (storageSettings.cleanupStrategy === 'delete_oldest') {
                        const bytesToFree = projectedTotal - storageLimit;
                        const cleanupResult = cleanupOldestMedia(bytesToFree);
                        fastify.log.info(
                            `Media storage cleanup: removed ${cleanupResult.deletedFiles} files, freed ${cleanupResult.freedBytes} bytes`
                        );
                    }

                    const recheckedUsage = getCurrentStorageUsage();
                    const recheckedProjectedTotal = recheckedUsage.totalBytes + uploadedBytes;
                    if (recheckedProjectedTotal > storageLimit) {
                        await safeUnlink(tempPath);
                        return reply.code(413).send({
                            error: 'Media storage quota exceeded',
                            code: 'MEDIA_STORAGE_QUOTA_EXCEEDED',
                            maxStorageSize: storageLimit,
                            currentStorageSize: recheckedUsage.totalBytes,
                            cleanupStrategy: storageSettings.cleanupStrategy,
                        });
                    }
                }
            }

            await fs.promises.rename(tempPath, finalPath);
            fileCommitted = true;

            // Save metadata to database
            const stmt = db.prepare(`
                INSERT INTO media_files (
                    original_name, 
                    encrypted_filename, 
                    mime_type, 
                    file_size,
                    uploaded_by
                ) VALUES (?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                data.filename,
                encryptedFilename,
                mimeTypeToUse,
                uploadedBytes,
                req.user.id
            );

            // Return file info
            reply.send({
                id: result.lastInsertRowid,
                original_name: data.filename,
                encrypted_filename: encryptedFilename,
                mime_type: mimeTypeToUse,
                file_size: uploadedBytes
            });
        } catch (error) {
            if (tempPath) {
                await safeUnlink(tempPath);
            }
            if (fileCommitted && finalPath) {
                await safeUnlink(finalPath);
            }

            if (
                error &&
                (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'RequestFileTooLargeError')
            ) {
                return reply.code(413).send({
                    error: 'File too large',
                    code: 'MEDIA_FILE_TOO_LARGE',
                    maxFileSize: getUploadSettings().maxFileSize,
                });
            }
            console.error('Upload error:', error);
            reply.code(500).send({ error: 'Upload failed', details: error.message });
        }
    });
    
    // Endpoint for serving media files (with optional audio transcode + Range support)
    fastify.get(
        '/api/media/:filename',
        {
            preHandler: [fastify.requireAuth],
        },
        async (req, reply) => {
            try {
                const { filename } = req.params;

                // Verify filename is safe (prevent path traversal)
                if (filename.includes('../') || filename.includes('..\\')) {
                    return reply.code(400).send({ error: 'Invalid filename' });
                }

                // Look up media by original encrypted filename
                let mediaFile = db
                    .prepare(
                        `
                    SELECT mf.*, m.room_id
                    FROM media_files mf
                    LEFT JOIN messages m ON mf.message_id = m.id
                    WHERE mf.encrypted_filename = ?
                `
                    )
                    .get(filename);

                if (!mediaFile) {
                    // It may be that the client requested the transcoded filename directly
                    mediaFile = db
                        .prepare(
                            `
                        SELECT mf.*, m.room_id
                        FROM media_files mf
                        LEFT JOIN messages m ON mf.message_id = m.id
                        WHERE mf.transcoded_filename = ?
                    `
                        )
                        .get(filename);
                }

                if (!mediaFile) {
                    return reply.code(404).send({ error: 'File not found' });
                }

                // In Chagourtee, all authenticated users have access to all rooms,
                // so we only need to check if the media file is associated with a message
                // that belongs to a room (which is already checked by the query above)
                // and if the requesting user is authenticated (which is handled by preHandler)

                const isAudio =
                    typeof mediaFile.mime_type === 'string' &&
                    mediaFile.mime_type.toLowerCase().startsWith('audio/');

                let encryptedFilenameToServe = mediaFile.encrypted_filename;
                let mimeTypeToServe = mediaFile.mime_type;

                if (isAudio) {
                    try {
                        const result = await ensureFlacTranscode(mediaFile);
                        encryptedFilenameToServe = result.encryptedFilenameToServe;
                        mimeTypeToServe = result.mimeTypeToServe;
                    } catch (e) {
                        fastify.log.error('Failed to prepare audio media file:', e);
                        // Fallback: continue with original encrypted file if it exists
                        encryptedFilenameToServe = mediaFile.encrypted_filename;
                        mimeTypeToServe = mediaFile.mime_type;
                    }
                }

                const filePath = path.resolve(MEDIA_DIR, encryptedFilenameToServe);
                if (!filePath.startsWith(MEDIA_DIR + path.sep)) {
                    return reply.code(400).send({ error: 'Invalid filename' });
                }

                if (!fs.existsSync(filePath)) {
                    return reply.code(404).send({ error: 'File not found' });
                }

                let keyBuffer;
                try {
                    keyBuffer = getMediaEncryptionKey();
                } catch (error) {
                    console.error('Media encryption is not configured correctly:', error.message);
                    return reply.code(500).send({ error: error.message });
                }

                let header;
                try {
                    header = readEncryptedFileHeader(filePath);
                } catch (error) {
                    console.error('Failed to read media file header:', error);
                    return reply.code(500).send({ error: 'Failed to read media file' });
                }

                const total = header.plaintextSize;
                const range = req.headers.range;

                reply.header('Accept-Ranges', 'bytes');

                if (!range) {
                    reply
                        .code(200)
                        .header('Content-Length', String(total))
                        .type(mimeTypeToServe);

                    if (total === 0) {
                        return reply.send(Buffer.alloc(0));
                    }

                    return reply.send(
                        createDecryptedRangeStream(filePath, header, keyBuffer, 0, total - 1)
                    );
                }

                // Parse Range header: bytes=start-end, bytes=start-, bytes=-suffix
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match || (match[1] === '' && match[2] === '')) {
                    reply
                        .code(416)
                        .header('Content-Range', `bytes */${total}`)
                        .send();
                    return;
                }

                let start;
                let end;

                if (match[1] === '') {
                    const suffixLength = parseInt(match[2], 10);
                    if (!Number.isFinite(suffixLength) || suffixLength <= 0 || total === 0) {
                        reply
                            .code(416)
                            .header('Content-Range', `bytes */${total}`)
                            .send();
                        return;
                    }
                    start = Math.max(total - suffixLength, 0);
                    end = total - 1;
                } else {
                    start = parseInt(match[1], 10);
                    end = match[2] === '' ? total - 1 : parseInt(match[2], 10);

                    if (
                        !Number.isFinite(start) ||
                        !Number.isFinite(end) ||
                        start < 0 ||
                        end < start ||
                        start >= total
                    ) {
                        reply
                            .code(416)
                            .header('Content-Range', `bytes */${total}`)
                            .send();
                        return;
                    }

                    if (end >= total) {
                        end = total - 1;
                    }
                }

                const contentLength = end - start + 1;
                return reply
                    .code(206)
                    .header('Content-Range', `bytes ${start}-${end}/${total}`)
                    .header('Content-Length', String(contentLength))
                    .type(mimeTypeToServe)
                    .send(
                        createDecryptedRangeStream(filePath, header, keyBuffer, start, end)
                    );
            } catch (error) {
                console.error('Serve media error:', error);
                reply.code(500).send({
                    error: 'Failed to serve media',
                    details: error.message,
                });
            }
        }
    );
}

module.exports = mediaPlugin;