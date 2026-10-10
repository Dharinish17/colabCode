# colabCode

colabCode is a collaborative coding workspace built with the MERN stack. Room members can edit files together, chat, share cursors, run code, and join optional voice chat.

## Features

- Public and private rooms with member, moderator, and owner permissions.
- Live code editing, presence, cursor sharing, and room chat.
- File management, ZIP export, and protected room links.
- Code execution through Wandbox.
- Optional WebRTC voice chat with microphone permissions.

## Tech stack

React, JavaScript, Tailwind CSS, Monaco Editor, Node.js, Express, Socket.IO, MongoDB/Mongoose, JWT cookies, and WebRTC.

## Local setup

Requirements: Node.js/npm, MongoDB, and a modern browser.

1. Copy the example environment file and set a MongoDB URI and a private JWT secret (at least 32 bytes):

   ```powershell
   Copy-Item .env.example .env
   ```

2. Install dependencies:

   ```powershell
   cd server
   npm install
   cd ..\client
   npm install
   ```

3. Start the backend and frontend in separate terminals:

   ```powershell
   cd server
   npm run dev
   ```

   ```powershell
   cd client
   npm run dev
   ```

Open `http://localhost:5173`. The API defaults to `http://localhost:5000`; check `/api/health` to confirm it is running.

## Configuration

The server reads `.env` from the repository root. Never commit `.env` or use real secrets in `.env.example`.

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string (required). |
| `JWT_SECRET` | Private JWT signing secret, at least 32 bytes (required). |
| `CLIENT_URL` | Frontend origin allowed by the API and Socket.IO; defaults to `http://localhost:5173`. |
| `SERVER_PORT` | API port; defaults to `5000`. |
| `NODE_ENV` | Use `production` for deployment. |
| `VITE_API_URL` | API/Socket.IO origin used when building the frontend; defaults to `http://localhost:5000`. |
| `STUN_URLS` | WebRTC STUN servers; defaults to Google's public STUN server. |
| `TURN_URLS`, `TURN_SHARED_SECRET` | Optional TURN server and its private coturn shared secret. Set both to use TURN. |
| `TURN_CREDENTIAL_TTL_SECONDS` | Lifetime of generated TURN credentials; defaults to `3600`. |

## How it works

- **Authentication:** Passwords are bcrypt-hashed. A seven-day JWT is stored in an HTTP-only cookie.
- **Authorization:** The backend checks room membership and role for REST and socket operations. A shared room URL does not grant access.
- **Collaboration:** REST handles account, room, file, history, and export operations. Socket.IO handles live edits, presence, cursors, chat, and notifications.
- **Voice:** Socket.IO carries WebRTC signaling; audio travels peer-to-peer and is not recorded or stored. Microphone access requires user permission and HTTPS in production. Configure TURN for restrictive networks. Mesh voice is limited to six connections per room; larger rooms should use an SFU.
- **Code execution:** Source is sent to Wandbox's public API. Do not run secrets or sensitive code through the service. Execution is limited to 100 KB, 30 seconds, and five requests per user per minute.

## Data and permissions

MongoDB stores users, rooms/files/access requests, and chat messages. Presence, cursors, and voice participants are transient in server memory.

| Capability | Owner | Moderator | Member |
|---|:---:|:---:|:---:|
| View room, edit files*, chat, export | Yes | Yes | Yes |
| Manage files and access requests | Yes | Yes | No |
| Remove regular members | Yes | Yes | No |
| Change room title, visibility, capacity | Yes | No | No |
| Promote moderators, transfer ownership, delete room | Yes | No | No |
| Manage member microphone permissions | Yes | Yes | No |

*Members can edit and run code only when member editing is enabled.

## API and socket reference

All routes below require authentication except `/api/health` and `/`. Room membership and role are checked server-side.

- **Auth:** `POST /api/auth/register`, `/login`, `/logout`; `GET /api/auth/me`.
- **Rooms:** `GET/POST /api/rooms`, `GET /mine`, `GET/PATCH/DELETE /:roomId`; join, leave, access requests, member roles, ownership, and sharing use routes under `/api/rooms/:roomId`.
- **Files and chat:** routes under `/api/rooms/:roomId/files`; `GET /:roomId/messages`, `GET /:roomId/download`, and `POST /:roomId/files/:fileId/run`.
- **Voice config:** `GET /api/rooms/:roomId/voice-config`.
- **Socket events:** `room:join`, `room:leave`, `editor:change/update`, `cursor:update/clear`, `chat:send/message`, presence events, access-request notifications, and `voice:join/leave/signal/mic-state/permission-set`.

## Running checks

```powershell
cd client
npm run build
cd ..\server
node --check server.js
node --check routes/rooms.js
node --check socket/index.js
```

Automated tests are not yet implemented; the server's `npm test` script is a placeholder. Before release, test room permissions, collaborative edits, chat, execution, and voice with multiple authenticated browsers. Cross-network voice testing requires a configured TURN server.
