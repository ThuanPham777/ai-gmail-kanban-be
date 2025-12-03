# React Authentication Backend

NestJS service that issues JWT access/refresh tokens, verifies Google Sign‑In credentials, and serves a mock email inbox for the frontend.

## Features
- Email/password registration & login with hashed passwords (bcrypt).
- Google One Tap / Sign-In credential exchange (`/user/google`).
- Refresh-token rotation with hashed persistence in MongoDB.
- Passport JWT guard that protects mock mailbox/email endpoints.
- Mock data layer (`src/mail`) that mimics folders, lists, and message details.

## Tech Stack
- NestJS 11, TypeScript, Mongoose 8
- Passport JWT, Google Auth Library
- MongoDB for persistent users & refresh tokens

## Getting Started

```bash
cd react-authentication-be
npm install
```

Create `.env` alongside `package.json`:

```env
MONGODB_URI=mongodb://localhost:27017/react-authentication
PORT=4000
CORS_ORIGIN=http://localhost:5173
JWT_ACCESS_SECRET=replace-with-strong-secret
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_SECRET=replace-with-refresh-secret # falls back to access secret if omitted
JWT_REFRESH_EXPIRES=7d

# Google Identity Services (app login only)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com

# IMAP account that powers the inbox (Track B)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=your-test-mailbox@gmail.com
IMAP_PASS=app-password-or-secret

# SMTP settings used to send/reply
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-test-mailbox@gmail.com
SMTP_PASS=app-password-or-secret
```

> **Heads-up:** `GOOGLE_CLIENT_ID` must match the client ID configured in Google Identity Services (used for app login).
> The IMAP/SMTP credentials should point to a test mailbox that the backend can log into (e.g., a Gmail account with IMAP enabled and an App Password).

### Useful Commands
| Action | Command |
| --- | --- |
| Start dev server with watch | `npm run start:dev` |
| Lint | `npm run lint` |
| Run tests | `npm run test` / `npm run test:e2e` |
| Production build | `npm run build` then `npm run start:prod` |

## API Overview
| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/user/register` | Email/password signup |
| `POST` | `/user/login` | Issue access + refresh token |
| `POST` | `/user/google` | Exchange Google credential for tokens |
| `POST` | `/user/refresh` | Rotate refresh token, issue new access token |
| `POST` | `/user/logout` | Revoke stored refresh token |
| `GET` | `/mailboxes` | List folders + unread counts (JWT required) |
| `GET` | `/mailboxes/:id/emails` | Paginated list for a folder (JWT required) |
| `GET` | `/emails/:id` | Email detail, metadata, attachments (JWT required) |

All protected routes expect `Authorization: Bearer <accessToken>`.

## Google Sign-In Checklist
1. Create an OAuth **Web application** client in Google Cloud Console.
2. Add your frontend origins (e.g., `http://localhost:5173`, production domain) to the client.
3. Copy the **Client ID** into both `GOOGLE_CLIENT_ID` (backend) and `VITE_GOOGLE_CLIENT_ID` (frontend).
4. Restart both servers so the new environment variables take effect.

## Mock Email Data
`src/mail/mock-data.ts` contains realistic folders, list rows, body HTML, and attachments. Because the data is static, you can demo the email dashboard without integrating with a real provider.

## Deployment Notes
- Provide a managed MongoDB connection string through `MONGODB_URI`.
- Ensure the deployed frontend origin is present in Google’s OAuth config and in `CORS_ORIGIN`.
- Never commit secrets—use environment variables provided by your host (Render, Vercel, etc.).***