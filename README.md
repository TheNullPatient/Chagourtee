![Chagourtee Logo](Chagourtee_logo.png)

# Chagourtee

Self-hosted messenger: the owner runs the server on their computer, creates invites and verifies participants manually or with one-time codes. In perspective — federation between servers.

[English version](./README.md) | [Версия на русском](./README.ru.md)

## Stack

- **Server:** Node.js, Fastify, SQLite (better-sqlite3), WebSocket (ws)
- **Client:** React, TypeScript, Vite

## Features

- **Self-hosting**: Full control over your data, deployment on your own server
- **User verification**: Owner approval or one-time codes, with an optional registration comment for context
- **Real-time chat**: Real-time communication with typing and presence indicators
- **User management**: Owner, moderator and member roles
- **Security**: Authorization via sessions, password hashing
- **Administration**: Control panel for creating rooms and invites
- **Message editing**: Ability to edit and delete own messages
- **Message replies**: Quotes, jump to the original message and a notification for the replied-to user
- **Room access levels**: Public, password-protected, private and invite-only rooms
  - The password is requested on every visit; it can be remembered for 5 minutes to 1 day, or until a manual lock
  - A lock button in the room header locks the room manually; owners and moderators can lock it for everyone
- **Message grouping**: Visual grouping of messages from the same user
- **Multi-message selection**: For bulk deletion

## Quick Start

### 1. Installation

```bash
npm install
```

### 2. Development mode

In two terminals:

```bash
# Server (port 3000)
npm run dev:server

# Client (port 5173, proxies /api and /ws to server)
npm run dev:client
```

Or with a single command:

```bash
npm run dev
```

Open http://localhost:5173

**Access from phone or other device on the same Wi-Fi:** open in browser `http://YOUR_COMPUTER_NAME_OR_IP:5173` (e.g., `http://macbook-dana.local:5173`). To make invite links point to this address (instead of localhost), create in the project root or in `client/` folder a `.env` file with:
```bash
VITE_APP_PUBLIC_URL=http://<YOUR_IP_ADDRESS>:5173
```
After changing, restart the client (`npm run dev:client`).

### 3. First owner

If there are no users in the database yet, the first owner can be created as follows:

1. Set environment variable (or add to `server/config.example.env` and rename to `.env`):
   ```bash
   export CHAGOURTEE_BOOTSTRAP_SECRET=your-secret-key
   ```
2. On the registration page (/register) or call the API:
   ```bash
   curl -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"login":"admin","password":"your-password","bootstrap":"your-secret-key"}'
   ```
3. Then log in with the created login – you are the owner. Create invites in Admin and rooms if needed.

### 4. Participants

- Owner (or moderator) creates an invite in Admin and shares the link like:  
  `https://your-address/register?invite=INVITE_CODE`
- Participant goes to the link, enters login and password, and may leave a comment for the owner if verification is enabled.
- The account stays in "waiting for verification" until the owner approves it in Admin or the participant uses a one-time code. The owner can choose to delete the comment automatically after approval.

## Build System

The project uses npm workspaces with separate client and server packages. Here's a summary of available commands:

| Command | Description |
|---------|-------------|
| `npm run dev` | Run both client and server in development mode |
| `npm run dev:server` | Run server only (with hot reload via nodemon) |
| `npm run dev:client` | Run client only (Vite dev server on :5173) |
| `npm run build` | Build both client and server for production |
| `npm run build:client` | Build client only (to `client/dist/`) |
| `npm run build:server` | Bundle server with esbuild (to `server/dist/`) |
| `npm start` | Start both client (preview) and server from production builds |
| `npm run start:server` | Start bundled server only |
| `npm run start:client` | Start client preview server only |
| `npm run update` | Update to latest version tag from remote |
| `npm run db:backup` | Backup SQLite database to `data/backups/` |
| `npm run generate-encryption-key` | Generate AES-256 media encryption key |
| `npm run lint` | Run ESLint and Stylelint on client code |
| `npm run lint:css` | Run Stylelint on CSS only |
| `npm run clear-logs` | Clear the log file |
| `npm run daemon:start` | Start server in background |
| `npm run daemon:stop` | Stop running server |
| `npm run daemon:restart` | Restart the server |
| `npm run daemon:status` | Check server status |

### Server bundling details

The server is bundled with [esbuild](https://esbuild.github.io/) for faster startup and easier deployment:

- **Target**: Compiled for your current Node.js version (v25.9.0) and platform (darwin/arm64)
- **Native modules**: `better-sqlite3`, `bcrypt`, and FFmpeg installers contain `.node` binary files that are platform-specific. These are kept as external dependencies and copied to `server/dist/node_modules/` during build
- **Data directory**: The `data/` folder is shared between development and production modes
- **Environment**: Variables are loaded from `server/.env` as usual

**Important:** If you deploy to a different platform (e.g., Linux server), you need to rebuild the server bundle on that platform to get the correct native module binaries.

## Deployment at owner's premises

### Production build

```bash
# Build both client and server
npm run build

# Or build individually:
npm run build:client   # builds client to client/dist/
npm run build:server   # bundles server to server/dist/ (with esbuild)
```

The built client will be in `client/dist/`. The bundled server will be in `server/dist/`.

**Note:** The server is bundled with [esbuild](https://esbuild.github.io/). Native modules (`better-sqlite3`, `bcrypt`, FFmpeg installers) contain platform-specific binaries and are kept as external dependencies. They are automatically copied to `server/dist/node_modules/` during build.

### Running production builds

```bash
# Start both client (preview) and server
npm start

# Or start individually:
npm run start:server   # starts the bundled server from server/dist/
npm run start:client   # starts the client preview server

# Note: If no production build exists, npm start will prompt you to build first
```

### Running the server (without bundling)

```bash
cd server
PORT=3000 node src/index.js
```

Recommended environment variables (or `.env` file in `server/`):

- `PORT` – port (default 3000)
- `HOST` – host (0.0.0.0 for access from other machines)
- `CHAGOURTEE_DB_PATH` – SQLite file path (default `./data/chagourtee.db`)
- `CHAGOURTEE_SESSION_SECRET` – secret for cookies (must be changed)
- `CHAGOURTEE_COOKIE_SECURE` – `Secure` flag for the session cookie: `auto` (default, enabled only over HTTPS), `true` or `false`. For plain HTTP deployments (e.g. `http://192.168.0.13:4173`) keep `auto` or set `false`
- `CHAGOURTEE_BOOTSTRAP_SECRET` – secret for creating the first owner (see above)
- `CHAGOURTEE_MAX_FILE_SIZE` – maximum file size for upload in bytes (default 52428800 = 50MB)
- `CHAGOURTEE_MEDIA_ENCRYPTION_KEY` – encryption key for media files (32 bytes for AES-256)
- `SECURE_CONNECTION` – `true` enables HTTPS and WSS for the API server (default `false`)
- `SSL_KEY_PATH` / `SSL_CERT_PATH` – paths to the private key and certificate (absolute or relative to the project root)
- `SSL_CA_PATH` – optional intermediate certificate chain
- `HTTP_REDIRECT_PORT` – port for the HTTP-to-HTTPS redirect (defaults to the HTTPS port + 1)
- `HTTP_REDIRECT_HOST` – host for the HTTP redirect (defaults to `HOST`)

### HTTPS/WSS

To enable a secure connection, point the server at a certificate and turn the mode on:

```bash
SECURE_CONNECTION=true
SSL_KEY_PATH=./certs/privkey.pem
SSL_CERT_PATH=./certs/fullchain.pem
# SSL_CA_PATH=./certs/chain.pem
# HTTP_REDIRECT_PORT=80   # defaults to the HTTPS port + 1
```

- `PORT` remains the application port; in this mode it serves HTTPS.
- WebSocket automatically becomes WSS — the client picks `ws` or `wss` from the page protocol, so no extra setting is needed.
- A second plain HTTP server on `HTTP_REDIRECT_PORT` answers every request with a permanent `308` redirect to HTTPS.
- The session cookie receives the `Secure` flag automatically (`CHAGOURTEE_COOKIE_SECURE=auto`). Do not set `CHAGOURTEE_COOKIE_SECURE=false` in an HTTPS deployment — otherwise the cookie is sent without the `Secure` flag.

For local testing you can generate a self-signed certificate:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/privkey.pem -out certs/fullchain.pem -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

In development, Vite proxies API and WebSocket traffic to the backend, so tell it which protocol to use:

```bash
SERVER_ORIGIN=https://127.0.0.1:3000 npm run dev
```

In production the client and API should be served over HTTPS from the same origin (usually via a reverse proxy: nginx, Caddy or Cloudflare Tunnel). The HTTP redirect covers the API server port only, not a separately served client.

### Logging

Chagourtee supports advanced logging configuration:

- `CHAGOURTEE_LOG_TO_FILE` – Enable logging to file (`true` or `false`, default `false`)
- `CHAGOURTEE_LOG_LEVEL` – Log level: `error`, `warn`, `info`, `debug`, `trace` (default `info`)
- `CHAGOURTEE_LOG_DIR` – Custom log directory (optional, defaults to `logs/` in project root)

When `CHAGOURTEE_LOG_TO_FILE=true`, all logs are written to `logs/chagourtee.log` in addition to console output.

To clear logs:
```bash
npm run clear-logs
```

### Running in Background

Use the daemon manager to run production builds in background:

```bash
# First, build
npm run build

# Start server + client in background
npm run daemon:start

# Check status
npm run daemon:status

# Stop both processes
npm run daemon:stop

# Restart both
npm run daemon:restart

# View live logs
tail -f logs/chagourtee.log
```

The daemon manager stores PIDs in `server/data/chagourtee-server.pid` and `server/data/chagourtee-client.pid`.

> **Note:** The daemon works only with production builds. For development, use `npm run dev` in a terminal.

### Internet access

A server behind NAT/home router is not accessible by external IP without port forwarding. Options:

- **Port forwarding** on the router to the machine with the server.
- **Tailscale / ZeroTier** – participants connect via assigned VPN addresses.
- **Cloudflare Tunnel** – tunnel from your machine to the internet via domain.

The client must open on the same origin as the API (or CORS configured and cookies with the correct domain).

### DB Backup

```bash
npm run db:backup
```

SQLite copy is saved to `data/backups/` (or alongside `CHAGOURTEE_DB_PATH` in subdirectory `backups`).

## Update the Service

To update your Chagourtee installation to the latest available version:

### From the project root:
```bash
npm run update
```

### Or run directly from the server:
```bash
cd server && npm run update-service
```

The update script will:
1. Check the current version of your installation
2. Fetch the latest available tags from the remote repository
3. Compare your current version with the latest available version
4. Prompt you to update if a newer version is available
5. Perform the update by:
   - Fetching the latest changes
   - Checking out the target version tag
   - Installing dependencies for all workspaces

> **Note**: Make sure you have committed any local changes before running the update, as the script will switch to a specific tag which may overwrite uncommitted changes.

## Testing

The server integration tests run from the project root:

```bash
npm test
```

Each test creates a temporary SQLite database and its own media directory (`CHAGOURTEE_MEDIA_DIR`), so the real `server/data/chagourtee.db` and `server/data/media` are never modified. The suite covers schema migrations, foreign keys and media cleanup when rooms/users are deleted, media uploads and downloads with quotas, audio transcoding, registration comments, verification and its server gate, room access levels, and WebSocket event validation.

Run a single suite directly:

```bash
cd server
node --test --expose-gc test/media.test.js
```

Client checks:

```bash
npm run build:client
npm run lint
```

## API (briefly)

- `POST /api/auth/login` – login
- `POST /api/auth/logout` – logout
- `GET /api/auth/me` – current user
- `POST /api/auth/register` – registration (inviteId or bootstrap)
- `GET/POST/PATCH/DELETE /api/rooms` – rooms (CRUD for the owner)
- `GET/PUT /api/rooms/:id/members` – access list for private and invite-only rooms
- `POST /api/rooms/:id/unlock` – enter a password-protected room (`rememberMinutes`: 0 = ask on every visit, 1–10080 minutes, `null` = never)
- `DELETE /api/rooms/:id/unlock` – forget the room password immediately
- `POST /api/rooms/:id/lock` – owner/moderator locks the room for everyone (drops all remembered passwords)
- `GET /api/rooms/:id/messages`, `POST /api/rooms/:id/messages` – messages
- `GET/POST/DELETE /api/invites` – invites
- `GET /api/verification/pending`, `POST /api/verification/approve`, `reject` – manual verification
- `GET /api/verification/comments` – saved comments of approved members
- `GET/PATCH /api/profile/registration-comment` – pending user's comment for the owner
- `POST /api/profile/change-password`, `change-login` – profile
- WebSocket `/ws` – new messages, typing, presence (after login via cookie)

## Architecture

### Client side

Frontend implemented with React using TypeScript and Vite. The application is organized into the following components:

- **AuthContext**: Authentication management and user state
- **Layout**: Main application layout
- **Pages**: Page components (Login, Register, Chat, Profile, Admin, VerificationWaiting)
- **API**: Module for server communication
- **WebSocket**: Real-time communication implementation

### Server side

Backend built on Fastify using SQLite for data storage:

- **DB**: Database connection via better-sqlite3
- **Auth**: Authentication and session management
- **Routes**: REST API for working with rooms, messages, invites, etc.
- **WS**: WebSocket server for real-time communication

### Security

- Password hashing with bcrypt
- Session protection via cookies with httpOnly and secure settings
- Permission checks for access to protected routes
- User verification checks for specific actions
- Unverified accounts are blocked from the REST API and WebSocket until approval
- Protection against unauthorized room access

## Functional capabilities

### For users:
- Registration via invites
- Login and logout
- Viewing and filtering rooms
- Sending, editing and deleting own messages
- Replying to messages with a quote and a jump to the original
- Entering password-protected rooms
- Showing "typing..." status
- Showing online status of other users
- Changing personal data and password

### For administrators (owner):
- Creating and renaming rooms
- Configuring room access level, password and the invite list
- Managing all users (including assigning moderator roles)
- Creating invites with restrictions
- Verifying users manually or with one-time codes
- Full access to admin panel
- Deleting any messages
- Editing information about any users

### For moderators:
- Creating and deleting invites
- Deleting messages from other users
- Access to invite management section in admin
- Editing user information

## Media Support

In recent updates, Chagourtee added support for sharing media files in chat. Users can share:

- Images (JPG, PNG, GIF, WebP, SVG, BMP, TIFF)
- Videos (MP4, WebM, OGG, MPEG, QuickTime)
- Audio files (MP3, WAV, AAC, OGG, MIDI, WebM, AIF, M4A, AIFF, ALAC, FLAC, etc.)
- Documents (PDF, DOC, DOCX, XLS, XLSX, TXT, ZIP, RAR, etc.)
- Any other file types (all file types are supported)

### Audio Transcoding

Chagourtee includes automatic audio transcoding for better browser compatibility. When certain audio formats that aren't well-supported across all browsers are uploaded, the system automatically converts them to FLAC format for playback:

- AIFF/AIFF files
- M4A files encoded with ALAC (Apple Lossless)
- Other audio formats that may cause playback issues in some browsers

When these files are accessed, the system will automatically convert them to FLAC format for broader browser compatibility. The transcoded version is cached and served to clients instead of the original file. The original file remains unchanged and secure.

**Note**: FFmpeg must be installed on the system for this feature to work. On most systems, you can install it with:

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# macOS with Homebrew
brew install ffmpeg

# Or install ffmpeg-static as a fallback:
cd server && npm install ffmpeg-static
```

### Setup

To enable media file encryption, you need to generate and configure an encryption key:

1. Generate a new encryption key:
   ```bash
   cd server
   npm run generate-encryption-key
   ```

2. Copy the generated key to your `.env` file as `CHAGOURTEE_MEDIA_ENCRYPTION_KEY`

3. All uploaded media files are encrypted using AES-256-GCM encryption and stored in `server/data/media/`.

**Important**: The encryption key must be exactly 32 bytes (64 hexadecimal characters) for AES-256 encryption.

Additionally, you can configure the maximum file size allowed for upload by setting the `CHAGOURTEE_MAX_FILE_SIZE` environment variable in bytes (default is 50MB = 52428800 bytes).

You can also configure the time-to-live for cached audio transcodes (in days) by setting the `CHAGOURTEE_AUDIO_TRANSCODE_TTL_DAYS` environment variable (default is 0, meaning no expiration until message deletion).

## License

MIT