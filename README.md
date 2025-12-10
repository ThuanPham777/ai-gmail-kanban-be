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
GOOGLE_CLIENT_SECRET=GOCSPX-...

OPENAI_API_KEY=sk-proj-....
OPENAI_MODEL_SUMMARY=gpt-oss-120b
```

How to run program

```bash
npm run start:dev
```

> **Heads-up:** `GOOGLE_CLIENT_ID` must match the client ID configured in Google Identity Services (used for app login).
> The IMAP/SMTP credentials should point to a test mailbox that the backend can log into (e.g., a Gmail account with IMAP enabled and an App Password).

### Useful Commands

| Action                      | Command                                   |
| --------------------------- | ----------------------------------------- |
| Start dev server with watch | `npm run start:dev`                       |
| Lint                        | `npm run lint`                            |
| Run tests                   | `npm run test` / `npm run test:e2e`       |
| Production build            | `npm run build` then `npm run start:prod` |

## API Overview

| Method | Endpoint                    | Description                                               |
| ------ | --------------------------- | --------------------------------------------------------- |
| `POST` | `/api/auth/register`        | Email/password signup                                     |
| `POST` | `/api/auth/login`           | Issue access + refresh token                              |
| `POST` | `/api/auth/google`          | Exchange Google credential for tokens                     |
| `POST` | `/api/auth/refresh`         | Rotate refresh token, issue new access token              |
| `POST` | `/api/auth/logout`          | Revoke stored refresh token                               |
| `GET`  | `/api/mailboxes`            | List folders + unread counts (JWT required)               |
| `GET`  | `/api/mailboxes/:id/emails` | Paginated list for a folder (JWT required)                |
| `GET`  | `/api/emails/:id`           | Email detail, metadata, attachments (JWT required)        |
| `GET`  | `/api/emails/send`          | Send email                                                |
| `POST` | `/api/emails/:id/reply`     | reply an email                                            |
| `POST` | `/api/emails/:id/modify`    | modify email (markRead, markUnread, star, unstar, delete) |

| `GET` | `/api/kanban/board` | get kanban board data (jwt requirments) |
| `PATCH` | `/api/kanban/items/:messageId/status` |update email status (jwt requirments) |
| `POST` | `/api/kanban/items/:messageId/snooze` | snooze email (jwt requirments) |
| `GET` | `/api/kanban/items/:messageId/summarize` | generate AI summary (jwt requirments) |

All protected routes expect `Authorization: Bearer <accessToken>`.

## Google Sign-In Checklist

1. Create an OAuth **Web application** client in Google Cloud Console.
2. Add your frontend origins (e.g., `http://localhost:5173`, production domain) to the client.
3. Copy the **Client ID** into both `GOOGLE_CLIENT_ID` (backend) and `VITE_GOOGLE_CLIENT_ID` (frontend).
4. Restart both servers so the new environment variables take effect.

## Deployment Notes

- Provide a managed MongoDB connection string through `MONGODB_URI`.
- Ensure the deployed frontend origin is present in Google’s OAuth config and in `CORS_ORIGIN`.
- Never commit secrets—use environment variables provided by your host (Render, Vercel, etc.).\*\*\*
