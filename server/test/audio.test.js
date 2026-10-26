'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const {
  createChecker,
  createWorkspace,
  removeWorkspace,
  seedUser,
  useWorkspace,
} = require('./helpers');

const workspace = createWorkspace('audio');
useWorkspace(workspace);

const Fastify = require('fastify');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { getDb } = require('../src/db');
const mediaPlugin = require('../src/media');

const ffmpegPath = ffmpegInstaller.path;
const ffmpegAvailable = Boolean(ffmpegPath) && fs.existsSync(ffmpegPath);

test(
  'ALAC uploads are transcoded to FLAC while MP3 is served as-is',
  { skip: ffmpegAvailable ? false : 'bundled ffmpeg is not available' },
  async () => {
    const { check, verify } = createChecker();
    const db = getDb();
    const ownerId = seedUser(db, 'audio_owner', { role: 'owner' });

    db.prepare(
      "UPDATE media_storage_settings SET max_file_size = -1, max_storage_size = 0, cleanup_strategy = 'block' WHERE id = 1"
    ).run();

    const wavPath = path.join(workspace.dir, 'tone.wav');
    const alacPath = path.join(workspace.dir, 'tone.m4a');
    const mp3Path = path.join(workspace.dir, 'tone.mp3');
    execFileSync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.5',
      wavPath,
    ]);
    execFileSync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      wavPath,
      '-c:a',
      'alac',
      alacPath,
    ]);
    execFileSync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      wavPath,
      '-codec:a',
      'libmp3lame',
      mp3Path,
    ]);

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
    app.decorate('broadcastAll', () => {});

    async function upload(baseUrl, filePath, mimeType) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([fs.readFileSync(filePath)], { type: mimeType }),
        path.basename(filePath)
      );
      const response = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { 'x-test-user': String(ownerId) },
        body: form,
      });
      return { status: response.status, body: await response.json() };
    }

    await app.register(mediaPlugin);
    await app.ready();
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const alac = await upload(baseUrl, alacPath, 'audio/mp4');
      check('ALAC upload succeeds', alac.status === 200, JSON.stringify(alac.body));

      const response = await fetch(`${baseUrl}/api/media/${alac.body.encrypted_filename}`, {
        headers: { 'x-test-user': String(ownerId) },
      });
      const body = Buffer.from(await response.arrayBuffer());
      check('transcoded ALAC download returns 200', response.status === 200, `${response.status}`);
      check(
        'transcoded ALAC is served as FLAC',
        /audio\/flac/.test(response.headers.get('content-type') || ''),
        response.headers.get('content-type')
      );
      check(
        'transcoded payload has the FLAC magic bytes',
        body.subarray(0, 4).toString('ascii') === 'fLaC',
        body.subarray(0, 8).toString('hex')
      );

      const mediaRow = db
        .prepare(
          'SELECT transcoded_filename, transcoded_mime_type FROM media_files WHERE id = ?'
        )
        .get(alac.body.id);
      check(
        'database records the transcoded file',
        Boolean(mediaRow) &&
          Boolean(mediaRow.transcoded_filename) &&
          mediaRow.transcoded_mime_type === 'audio/flac',
        JSON.stringify(mediaRow)
      );
      check(
        'no .part files remain after transcoding',
        fs.readdirSync(workspace.mediaDir).every((name) => !name.endsWith('.part'))
      );

      const transcodedEncrypted = path.join(workspace.mediaDir, mediaRow.transcoded_filename);
      check('transcoded encrypted file exists on disk', fs.existsSync(transcodedEncrypted));

      const rangeResponse = await fetch(
        `${baseUrl}/api/media/${mediaRow.transcoded_filename}`,
        { headers: { 'x-test-user': String(ownerId), range: 'bytes=0-3' } }
      );
      const rangeBody = Buffer.from(await rangeResponse.arrayBuffer());
      check(
        'transcoded file supports ranges',
        rangeResponse.status === 206 && rangeBody.toString('ascii') === 'fLaC',
        `${rangeResponse.status} ${rangeBody.toString('hex')}`
      );

      const mp3 = await upload(baseUrl, mp3Path, 'audio/mpeg');
      check('MP3 upload succeeds', mp3.status === 200, JSON.stringify(mp3.body));
      const mp3Response = await fetch(`${baseUrl}/api/media/${mp3.body.encrypted_filename}`, {
        headers: { 'x-test-user': String(ownerId) },
      });
      const mp3Body = Buffer.from(await mp3Response.arrayBuffer());
      check(
        'MP3 is served as-is without transcoding',
        mp3Response.status === 200 &&
          /audio\/mpeg/.test(mp3Response.headers.get('content-type') || '') &&
          mp3Body.length === fs.statSync(mp3Path).size,
        `${mp3Response.status} ${mp3Body.length}`
      );

      const mp3Row = db
        .prepare('SELECT transcoded_filename FROM media_files WHERE id = ?')
        .get(mp3.body.id);
      check('MP3 is not transcoded', !mp3Row || !mp3Row.transcoded_filename, JSON.stringify(mp3Row));
    } finally {
      await app.close();
      db.close();
      removeWorkspace(workspace);
    }

    verify();
  }
);
