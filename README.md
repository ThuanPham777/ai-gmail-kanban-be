# React Email Client And AI-powered Kanban Backend

NestJS backend service that powers an intelligent email management system with JWT authentication, Gmail API integration, and AI-powered Kanban board for organizing emails.

## Features

### Authentication & Security (Google OAuth 2.0 Only)

- **Google OAuth 2.0 code flow** - Single sign-in method for both login and registration
- **Gmail API scopes** - Automatic permission request for email read/modify/send
- **Offline refresh token** - Secure server-side storage for Gmail API access
- **JWT access/refresh token rotation** - Secure session management with token rotation
- **Hashed refresh tokens** - Server-side refresh tokens stored with bcrypt hashing
- **Automatic token refresh** - Transparent token renewal when access token expires
- **Concurrency handling** - Single refresh request when multiple 401s occur
- **Cross-tab sync** - BroadcastChannel for instant auth state synchronization
- **Secure logout** - Complete cleanup of all tokens (server + client side)

### Email Management

- Gmail API integration for real-time email sync
- Full email CRUD operations (read, send, reply, modify)
- Attachment support with metadata extraction
- Advanced email operations (mark read/unread, star, delete)

### AI-Powered Kanban Board

- Dynamic, user-customizable column configuration (stored in MongoDB)
- Drag-and-drop email organization with automatic Gmail label sync
- AI-powered email summarization using OpenAI API
- Smart snooze functionality with automatic wake-up
- Real-time board updates with pagination support
- Attachment detection and filtering

### Search & Discovery

- Fuzzy search with typo tolerance (Fuse.js)
- Semantic search using vector embeddings (Qdrant)
- Search suggestions with contact extraction

## Tech Stack

- **Framework**: NestJS 11, TypeScript 5
- **Database**: MongoDB (Mongoose 8), Qdrant Vector DB
- **Authentication**: Passport JWT, Google Auth Library
- **AI/ML**: OpenAI API, Vector embeddings
- **Email**: Gmail API with OAuth 2.0
- **Utilities**: Bcrypt, Fuse.js, Cron scheduler

## Getting Started

### 1. Install Dependencies

```bash
cd react-authentication-be
npm install
```

### 2. Configure Environment

Create `.env` file alongside `package.json`:

```env
MONGODB_URI=mongodb://localhost:27017/react-authentication
PORT=3000
CORS_ORIGIN=http://localhost:5173
JWT_ACCESS_SECRET=replace-with-strong-secret
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_SECRET=replace-with-refresh-secret # falls back to access secret if omitted
JWT_REFRESH_EXPIRES=7d

# Google Identity Services (app login only)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

OPENAI_API_KEY=sk-proj-....
OPENAI_MODEL_SUMMARY=

QDRANT_URL=
QDRANT_API_KEY=
```

### 3. Run Development Server

```bash
npm run start:dev
```

The backend will start on `http://localhost:3000`

> **Heads-up:** `GOOGLE_CLIENT_ID` must match the client ID configured in Google Identity Services (used for app login).

### Useful Commands

| Action                      | Command                                   |
| --------------------------- | ----------------------------------------- |
| Start dev server with watch | `npm run start:dev`                       |
| Lint                        | `npm run lint`                            |
| Run tests                   | `npm run test` / `npm run test:e2e`       |
| Production build            | `npm run build` then `npm run start:prod` |

## API Overview

### Authentication Endpoints

| Method | Endpoint                 | Description                                                                                                      |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/auth/google/login` | Google OAuth code flow (Gmail scopes + offline refresh token). Handles both login (existing) and register (new). |
| `POST` | `/api/auth/refresh`      | Rotate refresh token, issue new access token                                                                     |
| `POST` | `/api/auth/logout`       | Revoke stored refresh token, clear server-side session                                                           |

**Note:** This app uses Google OAuth 2.0 exclusively. Email/password authentication has been removed.

### Health

| Method | Endpoint  | Description  |
| ------ | --------- | ------------ |
| `GET`  | `/health` | Health check |

### Mailbox & Email Endpoints

| Method | Endpoint                    | Description                                                                             |
| ------ | --------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/api/mailboxes`            | List folders + unread counts (JWT)                                                      |
| `GET`  | `/api/mailboxes/:id/emails` | Paginated list for a folder (JWT). Supports `pageToken` + `limit`, with `page` fallback |
| `GET`  | `/api/emails/:id`           | Email detail, metadata, attachments (JWT)                                               |
| `POST` | `/api/emails/send`          | Send email (JWT)                                                                        |
| `POST` | `/api/emails/:id/reply`     | Reply to an email (JWT)                                                                 |
| `POST` | `/api/emails/:id/forward`   | Forward an email (JWT)                                                                  |
| `POST` | `/api/emails/:id/modify`    | Modify email (mark read/unread, star, etc)                                              |
| `GET`  | `/api/attachments/:id`      | Download attachment (JWT)                                                               |

### Kanban Board Endpoints

| Method  | Endpoint                                          | Description                        |
| ------- | ------------------------------------------------- | ---------------------------------- |
| `GET`   | `/api/kanban/board`                               | Get kanban board data (JWT)        |
| `GET`   | `/api/kanban/gmail-labels`                        | List available Gmail labels (JWT)  |
| `POST`  | `/api/kanban/validate-label`                      | Validate a Gmail label name (JWT)  |
| `GET`   | `/api/kanban/search`                              | Fuzzy search emails (JWT)          |
| `POST`  | `/api/kanban/search/semantic`                     | Semantic vector search (JWT)       |
| `GET`   | `/api/kanban/search/suggestions`                  | Get search suggestions (JWT)       |
| `POST`  | `/api/kanban/items/:messageId/generate-embedding` | Generate embedding for email (JWT) |
| `PATCH` | `/api/kanban/items/:messageId/status`             | Update email status (JWT)          |
| `POST`  | `/api/kanban/items/:messageId/snooze`             | Snooze email until date (JWT)      |
| `POST`  | `/api/kanban/items/:messageId/summarize`          | Generate AI summary (JWT)          |
| `GET`   | `/api/kanban/columns`                             | Get user's column config (JWT)     |
| `POST`  | `/api/kanban/columns`                             | Update column configuration (JWT)  |

All protected routes expect `Authorization: Bearer <accessToken>`.

## Google Sign-In Checklist

1. Create an OAuth **Web application** client in Google Cloud Console.
2. Add your frontend origins (e.g., `http://localhost:5173`, production domain) to the client.
3. Copy the **Client ID** into both `GOOGLE_CLIENT_ID` (backend) and `VITE_GOOGLE_CLIENT_ID` (frontend).
4. Restart both servers so the new environment variables take effect.

## Deployment Notes

- Provide a managed MongoDB connection string through `MONGODB_URI`.
- Ensure the deployed frontend origin is present in Google’s OAuth config and in `CORS_ORIGIN`.
- Never commit secrets—use environment variables provided by your host (Render, Vercel, etc.).
