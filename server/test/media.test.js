'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createChecker,
  createWorkspace,
  removeWorkspace,
  seedUser,
  useWorkspace,
} = require('./helpers');

const workspace = createWorkspace('media');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const mediaPlugin = require('../src/media');
const { hasPermission } = require('../src/permissions');

test('media uploads, downloads and quotas', async () => {
  const { check, verify } = createChecker();
  const db = getDb();
  const ownerId = seedUser(db, 'media_owner', { role: 'owner' });

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('getUser', (id) =>
    db.prepare('SELECT id, login, role FROM users WHERE id = ?').get(id)
  );
  app.decorate('requireAuth', async (request, reply) => {
    const id = Number(request.headers['x-test-user']);
    const user = id ? app.getUser(id) : null;
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    request.user = user;
  });
  app.decorate('requireOwner', app.requireAuth);
  app.decorate('requirePermission', (permission) => async (request, reply) => {
    const user = request.user || app.getUser(Number(request.headers['x-test-user']));
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    if (!hasPermission(db, user, permission)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    request.user = user;
  });
  const broadcastEvents = [];
  app.decorate('broadcastAll', (payload) => {
    broadcastEvents.push(payload);
  });

  function setSettings({ maxFileSize, maxStorageSize, cleanupStrategy = 'block' }) {
    db.prepare(
      `UPDATE media_storage_settings
       SET max_file_size = ?, max_storage_size = ?, cleanup_strategy = ?
       WHERE id = 1`
    ).run(maxFileSize, maxStorageSize, cleanupStrategy);
  }

  async function upload(baseUrl, name, bytes, type) {
    const form = new FormData();
    form.append('file', new Blob([bytes], type ? { type } : undefined), name);
    const response = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'x-test-user': String(ownerId) },
      body: form,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  async function getMedia(baseUrl, filename, range, userId = ownerId) {
    const headers = { 'x-test-user': String(userId) };
    if (range) headers.range = range;
    const response = await fetch(`${baseUrl}/api/media/${filename}`, { headers });
    return {
      status: response.status,
      headers: response.headers,
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  }

  const countMediaRows = () =>
    db.prepare('SELECT COUNT(*) AS count FROM media_files').get().count;
  const listMediaDir = () => fs.readdirSync(workspace.mediaDir).sort();
  const sameList = (a, b) => a.length === b.length && a.every((name, i) => name === b[i]);

  await app.register(mediaPlugin);
  await app.ready();
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  try {
    // --- Settings are readable by members and include storage usage --------
    const memberId = seedUser(db, 'media_member');
    const memberSettingsResponse = await fetch(`${baseUrl}/api/media/settings`, {
      headers: { 'x-test-user': String(memberId) },
    });
    const memberSettings = await memberSettingsResponse.json();
    check(
      'members can read media settings',
      memberSettingsResponse.status === 200,
      `${memberSettingsResponse.status}`
    );
    check(
      'media settings expose the storage quota and usage',
      memberSettings.storage &&
        (memberSettings.storage.maxStorageSize === null ||
          typeof memberSettings.storage.maxStorageSize === 'number') &&
        typeof memberSettings.storage.totalBytes === 'number' &&
        typeof memberSettings.storage.filesCount === 'number',
      JSON.stringify(memberSettings.storage)
    );

    // --- Upload, encryption, download and ranges ---------------------------
    setSettings({ maxFileSize: 1024 * 1024, maxStorageSize: 0 });
    const payload = Buffer.alloc(5000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const uploaded = await upload(baseUrl, 'sample.bin', payload);
    check('small upload succeeds', uploaded.status === 200, JSON.stringify(uploaded.body));
    check(
      'upload reports the plaintext size',
      uploaded.body && uploaded.body.file_size === payload.length,
      JSON.stringify(uploaded.body)
    );
    check(
      'upload returns an encrypted filename',
      uploaded.body && /\.enc$/.test(uploaded.body.encrypted_filename),
      JSON.stringify(uploaded.body)
    );

    const usageEvent = broadcastEvents.find(
      (event) => event.type === 'media_usage_changed'
    );
    check(
      'upload broadcasts live storage usage',
      usageEvent &&
        usageEvent.totalBytes === payload.length &&
        usageEvent.filesCount === 1,
      JSON.stringify(usageEvent)
    );

    const encryptedPath = path.join(workspace.mediaDir, uploaded.body.encrypted_filename);
    const encryptedBytes = fs.readFileSync(encryptedPath);
    check(
      'encrypted file stores the plaintext size plus a 32 byte header',
      encryptedBytes.length === payload.length + 32
    );
    check(
      'encrypted file does not contain plaintext',
      !encryptedBytes.includes(payload.subarray(0, 64))
    );
    check(
      'no temporary .part files remain',
      listMediaDir().every((name) => !name.endsWith('.part'))
    );

    const whole = await getMedia(baseUrl, uploaded.body.encrypted_filename);
    check('whole-file download returns 200', whole.status === 200, `${whole.status}`);
    check(
      'whole-file download matches the upload',
      Buffer.compare(whole.buffer, payload) === 0
    );
    check('whole-file response advertises ranges', whole.headers.get('accept-ranges') === 'bytes');

    const ranged = await getMedia(baseUrl, uploaded.body.encrypted_filename, 'bytes=10-19');
    check('range request returns 206', ranged.status === 206, `${ranged.status}`);
    check(
      'range response has the right Content-Range',
      ranged.headers.get('content-range') === `bytes 10-19/${payload.length}`,
      ranged.headers.get('content-range')
    );
    check(
      'range response contains the right bytes',
      Buffer.compare(ranged.buffer, payload.subarray(10, 20)) === 0
    );

    const openEnded = await getMedia(baseUrl, uploaded.body.encrypted_filename, 'bytes=4990-');
    check(
      'open-ended range returns the tail',
      openEnded.status === 206 &&
        Buffer.compare(openEnded.buffer, payload.subarray(4990)) === 0
    );

    const suffix = await getMedia(baseUrl, uploaded.body.encrypted_filename, 'bytes=-100');
    check(
      'suffix range returns the last bytes',
      suffix.status === 206 &&
        Buffer.compare(suffix.buffer, payload.subarray(payload.length - 100)) === 0,
      suffix.headers.get('content-range')
    );

    const outOfRange = await getMedia(
      baseUrl,
      uploaded.body.encrypted_filename,
      `bytes=${payload.length}-`
    );
    check('out-of-range request returns 416', outOfRange.status === 416, `${outOfRange.status}`);

    // --- Empty upload ------------------------------------------------------
    const empty = await upload(baseUrl, 'empty.txt', Buffer.alloc(0));
    check(
      'empty upload succeeds',
      empty.status === 200 && empty.body.file_size === 0,
      JSON.stringify(empty.body)
    );
    const emptyDownload = await getMedia(baseUrl, empty.body.encrypted_filename);
    check(
      'empty download returns 200 with zero bytes',
      emptyDownload.status === 200 && emptyDownload.buffer.length === 0
    );

    // --- Per-file limit ----------------------------------------------------
    setSettings({ maxFileSize: 1000, maxStorageSize: 0 });
    const rowsBeforeLimit = countMediaRows();
    const filesBeforeLimit = listMediaDir();
    const tooLarge = await upload(baseUrl, 'big.bin', Buffer.alloc(5000, 7));
    check('over-limit upload returns 413', tooLarge.status === 413, JSON.stringify(tooLarge.body));
    check(
      'over-limit upload reports MEDIA_FILE_TOO_LARGE',
      tooLarge.body && tooLarge.body.code === 'MEDIA_FILE_TOO_LARGE',
      JSON.stringify(tooLarge.body)
    );
    check('over-limit upload writes no DB row', countMediaRows() === rowsBeforeLimit);
    check(
      'over-limit upload leaves no files behind',
      sameList(listMediaDir(), filesBeforeLimit)
    );

    // Exactly at the limit must be accepted.
    const exact = await upload(baseUrl, 'exact.bin', Buffer.alloc(1000, 3));
    check(
      'upload exactly at the limit succeeds',
      exact.status === 200 && exact.body.file_size === 1000,
      JSON.stringify(exact.body)
    );

    // --- Disabled and unlimited uploads -----------------------------------
    setSettings({ maxFileSize: 0, maxStorageSize: 0 });
    const disabled = await upload(baseUrl, 'disabled.bin', Buffer.alloc(10));
    check(
      'disabled uploads return 403',
      disabled.status === 403 && disabled.body.code === 'MEDIA_UPLOAD_DISABLED',
      JSON.stringify(disabled.body)
    );

    setSettings({ maxFileSize: -1, maxStorageSize: 0 });
    const largePayload = Buffer.alloc(8 * 1024 * 1024, 9);
    const unlimited = await upload(baseUrl, 'unlimited.bin', largePayload);
    check(
      'unlimited upload succeeds',
      unlimited.status === 200 && unlimited.body.file_size === largePayload.length,
      JSON.stringify(unlimited.body)
    );
    const unlimitedRange = await getMedia(
      baseUrl,
      unlimited.body.encrypted_filename,
      'bytes=1000-1999'
    );
    check(
      'unlimited upload round-trips through ranges',
      unlimitedRange.status === 206 &&
        Buffer.compare(unlimitedRange.buffer, largePayload.subarray(1000, 2000)) === 0
    );

    // --- Storage quota: block ---------------------------------------------
    const currentUsage = db
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS total FROM media_files')
      .get().total;
    setSettings({
      maxFileSize: -1,
      maxStorageSize: currentUsage + 500,
      cleanupStrategy: 'block',
    });
    const filesBeforeQuota = listMediaDir();
    const quotaBlocked = await upload(baseUrl, 'quota.bin', Buffer.alloc(5000, 1));
    check(
      'storage quota block returns 413',
      quotaBlocked.status === 413,
      JSON.stringify(quotaBlocked.body)
    );
    check(
      'storage quota error has the right code',
      quotaBlocked.body && quotaBlocked.body.code === 'MEDIA_STORAGE_QUOTA_EXCEEDED',
      JSON.stringify(quotaBlocked.body)
    );
    check(
      'quota failure leaves no files behind',
      sameList(listMediaDir(), filesBeforeQuota)
    );

    // --- Storage quota: delete_oldest -------------------------------------
    setSettings({ maxFileSize: -1, maxStorageSize: 6000, cleanupStrategy: 'delete_oldest' });
    const beforeCleanupIds = db
      .prepare('SELECT id FROM media_files ORDER BY datetime(created_at) ASC, id ASC')
      .all()
      .map((row) => row.id);
    const cleanupUpload = await upload(baseUrl, 'cleanup.bin', Buffer.alloc(5000, 2));
    check(
      'delete_oldest upload succeeds',
      cleanupUpload.status === 200,
      JSON.stringify(cleanupUpload.body)
    );
    const usageAfterCleanup = db
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS total FROM media_files')
      .get().total;
    check('delete_oldest keeps usage within the quota', usageAfterCleanup <= 6000, `${usageAfterCleanup}`);
    const remainingIds = new Set(
      db.prepare('SELECT id FROM media_files').all().map((row) => row.id)
    );
    check(
      'delete_oldest removed at least one old file',
      beforeCleanupIds.some((id) => !remainingIds.has(id))
    );

    // --- Bad requests ------------------------------------------------------
    const noAuth = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: new FormData() });
    check('upload requires authentication', noAuth.status === 401, `${noAuth.status}`);

    const notMultipart = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'x-test-user': String(ownerId), 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    check('non-multipart upload returns 400', notMultipart.status === 400, `${notMultipart.status}`);

    // --- Orphan media is private to its uploader ---------------------------
    setSettings({ maxFileSize: -1, maxStorageSize: 0 });
    const orphan = await upload(baseUrl, 'orphan.bin', Buffer.from('orphan bytes'));
    check('orphan upload succeeds', orphan.status === 200, JSON.stringify(orphan.body));

    const orphanAsMember = await getMedia(
      baseUrl,
      orphan.body.encrypted_filename,
      undefined,
      memberId
    );
    check(
      'orphan media is hidden from other users',
      orphanAsMember.status === 404,
      `${orphanAsMember.status}`
    );
    const orphanAsOwner = await getMedia(baseUrl, orphan.body.encrypted_filename);
    check(
      'uploader can still read their own orphan media',
      orphanAsOwner.status === 200 &&
        Buffer.compare(orphanAsOwner.buffer, Buffer.from('orphan bytes')) === 0,
      `${orphanAsOwner.status}`
    );

    // --- Media attached to a private room follows room access --------------
    const privateMedia = await upload(baseUrl, 'private.bin', Buffer.from('private bytes'));
    const privateRoomId = Number(
      db
        .prepare(
          "INSERT INTO rooms (name, created_by, access_level) VALUES (?, ?, 'private')"
        )
        .run(`media_private_${Date.now()}`, ownerId).lastInsertRowid
    );
    const privateMessageId = Number(
      db
        .prepare("INSERT INTO messages (room_id, user_id, body) VALUES (?, ?, 'private media')")
        .run(privateRoomId, ownerId).lastInsertRowid
    );
    db.prepare('UPDATE media_files SET message_id = ? WHERE id = ?').run(
      privateMessageId,
      privateMedia.body.id
    );

    const privateAsOutsider = await getMedia(
      baseUrl,
      privateMedia.body.encrypted_filename,
      undefined,
      memberId
    );
    check(
      'private room media is hidden from non-members',
      privateAsOutsider.status === 404,
      `${privateAsOutsider.status}`
    );

    const privateAsOwner = await getMedia(baseUrl, privateMedia.body.encrypted_filename);
    check(
      'owner can read media in their private room',
      privateAsOwner.status === 200,
      `${privateAsOwner.status}`
    );

    db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)').run(
      privateRoomId,
      memberId
    );
    const privateAsMember = await getMedia(
      baseUrl,
      privateMedia.body.encrypted_filename,
      undefined,
      memberId
    );
    check(
      'private room member can read room media',
      privateAsMember.status === 200 &&
        Buffer.compare(privateAsMember.buffer, Buffer.from('private bytes')) === 0,
      `${privateAsMember.status}`
    );

    // --- Unsafe MIME types are forced to download --------------------------
    const htmlUpload = await upload(
      baseUrl,
      'evil.html',
      Buffer.from('<script>alert(1)</script>'),
      'text/html'
    );
    const htmlResponse = await getMedia(baseUrl, htmlUpload.body.encrypted_filename);
    check(
      'HTML media is served as an octet stream',
      htmlResponse.status === 200 &&
        htmlResponse.headers.get('content-type')?.startsWith('application/octet-stream'),
      htmlResponse.headers.get('content-type')
    );
    check(
      'HTML media is marked as an attachment',
      htmlResponse.headers.get('content-disposition')?.startsWith('attachment'),
      htmlResponse.headers.get('content-disposition')
    );
    check(
      'media responses deny MIME sniffing',
      htmlResponse.headers.get('x-content-type-options') === 'nosniff'
    );
    check(
      'media responses are sandboxed',
      htmlResponse.headers.get('content-security-policy')?.includes('sandbox'),
      htmlResponse.headers.get('content-security-policy')
    );

    const svgUpload = await upload(
      baseUrl,
      'evil.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'image/svg+xml'
    );
    const svgResponse = await getMedia(baseUrl, svgUpload.body.encrypted_filename);
    check(
      'SVG media is not served as an inline image',
      svgResponse.headers.get('content-type')?.startsWith('application/octet-stream') &&
        svgResponse.headers.get('content-disposition')?.startsWith('attachment'),
      `${svgResponse.headers.get('content-type')} / ${svgResponse.headers.get('content-disposition')}`
    );

    const pngUpload = await upload(
      baseUrl,
      'pixel.png',
      Buffer.from('89504e470d0a1a0a', 'hex'),
      'image/png'
    );
    const pngResponse = await getMedia(baseUrl, pngUpload.body.encrypted_filename);
    check(
      'safe images keep their type and inline disposition',
      pngResponse.headers.get('content-type')?.startsWith('image/png') &&
        pngResponse.headers.get('content-disposition')?.startsWith('inline'),
      `${pngResponse.headers.get('content-type')} / ${pngResponse.headers.get('content-disposition')}`
    );

    // --- Bounded memory ----------------------------------------------------
    setSettings({ maxFileSize: -1, maxStorageSize: 0 });
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const hugePayload = Buffer.alloc(32 * 1024 * 1024, 4);
    const huge = await upload(baseUrl, 'huge.bin', hugePayload);
    const heapAfter = process.memoryUsage().heapUsed;
    check(
      '32 MB streamed upload succeeds',
      huge.status === 200 && huge.body.file_size === hugePayload.length,
      JSON.stringify(huge.body)
    );
    check(
      'upload heap growth stays bounded',
      heapAfter - heapBefore < 40 * 1024 * 1024,
      `${Math.round((heapAfter - heapBefore) / (1024 * 1024))} MB`
    );
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
