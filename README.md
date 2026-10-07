# CodeRoom

CodeRoom is a collaborative coding workspace built with React, Vite, Express, MongoDB, and Socket.IO.

## Authentication

The server provides:

- `POST /api/auth/register` — create an account with a username, email, password, and password confirmation.
- `POST /api/auth/login` — verify credentials and set a seven-day JWT in an HTTP-only cookie.
- `POST /api/auth/logout` — clear the authentication cookie.
- `GET /api/auth/me` — return the signed-in user's public profile.

The `/workspace` frontend route and Socket.IO connections require a valid session. User records contain a bcrypt password hash; API responses include only the user's ID, username, and email.

## Local setup

1. Create a root `.env` file using `.env.example` as a template.
2. Set `MONGODB_URI` to a reachable MongoDB database.
3. Set `JWT_SECRET` to a private, randomly generated value of at least 32 bytes. Do not commit the `.env` file or expose this secret to the frontend.
4. Start the API from `server/` with `npm run dev`.
5. Start the frontend from `client/` with `npm run dev`.

The browser sends the HTTP-only cookie to the API; frontend requests include credentials. In production the cookie is marked `Secure`.