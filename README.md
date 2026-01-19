# React Email Client Integration Gmail & AI-Powered Kanban - Backend

NestJS backend service powering an intelligent email management system with JWT authentication, Gmail API integration, AI-powered Kanban board, and real-time notifications.

## 🚀 Features

### Authentication & Security (Google OAuth 2.0)

- **Google OAuth 2.0 Authorization Code Flow** - Secure sign-in with Gmail scope access
- **Offline Refresh Token** - Server-side encrypted storage for persistent Gmail API access
- **JWT Token Rotation** - Access token (15m) + Refresh token (7d) with automatic rotation
- **HttpOnly Cookie Storage** - Refresh token stored in secure HttpOnly cookie (XSS-safe)
- **Hashed Refresh Tokens** - Bcrypt-hashed server-side storage for validation
- **Concurrency Handling** - Single refresh request queuing for multiple 401s
- **Forced Logout** - Automatic session termination on invalid refresh token

### Email Management (Gmail API)

- **Full Gmail Integration** - Read, send, reply, forward, delete emails
- **Mailbox/Labels Support** - System labels + user-created labels with unread counts
- **Attachment Handling** - View, download with proper filename/mimeType extraction
- **Email Threading** - In-Reply-To and References headers for proper threading
- **Pagination** - Token-based pagination with `nextPageToken` support

### AI-Powered Kanban Board

- **Dynamic Column Configuration** - User-customizable columns stored in MongoDB
- **Gmail Label Mapping** - Columns sync with Gmail labels on drag-drop
- **AI Summarization** - OpenAI GPT integration for email summaries (cached 24h)
- **Vector Embeddings** - Text-embedding-3-small for semantic search
- **Snooze Functionality** - Hide emails until specified date/time with auto-wake cron
- **On-Demand Sync** - Lazy loading from Gmail when scrolling

### Search & Discovery

- **Fuzzy Search** - Typo-tolerant search using Fuse.js (threshold: 0.45)
- **Semantic Search** - Vector similarity search with Qdrant (cosine distance)
- **Search Suggestions** - Contact names and keyword auto-complete

### Real-Time Features

- **Gmail Push Notifications** - Google Pub/Sub webhook integration
- **WebSocket Gateway** - Socket.IO for instant UI updates
- **Watch Renewal** - Automatic cron job every 6 hours

## 🛠 Tech Stack

| Category       | Technologies                                     |
| -------------- | ------------------------------------------------ |
| Framework      | NestJS 11, TypeScript 5.7                        |
| Database       | MongoDB (Mongoose 8), Qdrant Vector DB           |
| Authentication | Passport JWT, Google Auth Library                |
| AI/ML          | OpenAI API (GPT-4o-mini, text-embedding-3-small) |
| Email          | Gmail API v1 with OAuth 2.0                      |
| Real-time      | Socket.IO, Google Pub/Sub                        |
| Scheduling     | @nestjs/schedule (Cron)                          |
| Search         | Fuse.js, Qdrant                                  |

## 📦 Getting Started

### Prerequisites

- Node.js 20.x or higher
- MongoDB 7.x (local or Atlas)
- Qdrant (local or cloud)
- Google Cloud Project with Gmail API enabled

### 1. Install Dependencies

```bash
cd ai-gmail-kanban-be
npm install
```

### 2. Configure Environment

Create `.env` file:

```env
# Server
PORT=3000
CORS_ORIGIN=http://localhost:5173

# Database
MONGODB_URI=mongodb://localhost:27017/email-kanban

# JWT Secrets
JWT_ACCESS_SECRET=your-super-secret-access-key
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_SECRET=your-super-secret-refresh-key
JWT_REFRESH_EXPIRES=7d

# Google OAuth 2.0
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-client-secret

# OpenAI
OPENAI_API_KEY=sk-proj-your-openai-key
OPENAI_MODEL_SUMMARY=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Qdrant Vector Database
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-qdrant-api-key

# Gmail Push Notifications (optional)
GMAIL_PUBSUB_TOPIC=projects/your-project/topics/gmail-notifications
```

### 3. Run Development Server

```bash
npm run start:dev
```

Server starts at `http://localhost:3000`

### 4. Docker Compose (Optional)

```bash
docker-compose up -d
```

This starts MongoDB and Qdrant containers.

## 📚 API Reference

### Authentication

| Method | Endpoint                 | Description                                               |
| ------ | ------------------------ | --------------------------------------------------------- |
| `POST` | `/api/auth/google/login` | Google OAuth code exchange → sets HttpOnly refresh cookie |
| `POST` | `/api/auth/refresh`      | Rotate tokens (reads refresh token from cookie)           |
| `POST` | `/api/auth/logout`       | Revoke refresh token + clear cookie                       |

> **Note**: Refresh token is sent/received via HttpOnly cookie, not request/response body.

### Email

| Method | Endpoint                    | Description                                 |
| ------ | --------------------------- | ------------------------------------------- |
| `GET`  | `/api/mailboxes`            | List Gmail labels with unread counts        |
| `GET`  | `/api/mailboxes/:id/emails` | Paginated email list (`pageToken`, `limit`) |
| `GET`  | `/api/emails/:id`           | Full email detail with body                 |
| `POST` | `/api/emails/send`          | Send new email                              |
| `POST` | `/api/emails/:id/reply`     | Reply to email (supports `replyAll`)        |
| `POST` | `/api/emails/:id/forward`   | Forward email                               |
| `POST` | `/api/emails/:id/modify`    | Mark read/unread, star, delete              |
| `GET`  | `/api/attachments/:id`      | Download attachment (`emailId` query param) |

### Kanban Board

| Method  | Endpoint                                          | Description                     |
| ------- | ------------------------------------------------- | ------------------------------- |
| `GET`   | `/api/kanban/board`                               | Get board data with pagination  |
| `GET`   | `/api/kanban/columns`                             | Get user's column configuration |
| `POST`  | `/api/kanban/columns`                             | Update column configuration     |
| `GET`   | `/api/kanban/gmail-labels`                        | List available Gmail labels     |
| `POST`  | `/api/kanban/validate-label`                      | Validate Gmail label name       |
| `PATCH` | `/api/kanban/items/:messageId/status`             | Move email to column            |
| `POST`  | `/api/kanban/items/:messageId/snooze`             | Snooze until datetime           |
| `POST`  | `/api/kanban/items/:messageId/summarize`          | Generate AI summary             |
| `POST`  | `/api/kanban/items/:messageId/generate-embedding` | Generate vector embedding       |

### Search

| Method | Endpoint                         | Description                 |
| ------ | -------------------------------- | --------------------------- |
| `GET`  | `/api/kanban/search`             | Fuzzy search (`q`, `limit`) |
| `POST` | `/api/kanban/search/semantic`    | Semantic vector search      |
| `GET`  | `/api/kanban/search/suggestions` | Auto-suggestions            |

### Gmail Push Notifications

| Method | Endpoint                 | Description                        |
| ------ | ------------------------ | ---------------------------------- |
| `POST` | `/api/gmail/watch/start` | Start Gmail watch                  |
| `POST` | `/api/gmail/watch/stop`  | Stop Gmail watch                   |
| `POST` | `/api/gmail/webhook`     | Pub/Sub webhook (no auth required) |

### Health

| Method | Endpoint  | Description  |
| ------ | --------- | ------------ |
| `GET`  | `/health` | Health check |

> All endpoints except `/health` and `/api/gmail/webhook` require `Authorization: Bearer <accessToken>`

## 🔧 Scripts

| Command              | Description                 |
| -------------------- | --------------------------- |
| `npm run start:dev`  | Development with hot-reload |
| `npm run build`      | Production build            |
| `npm run start:prod` | Run production build        |
| `npm run lint`       | ESLint check                |
| `npm run test`       | Unit tests                  |
| `npm run test:e2e`   | E2E tests                   |

## 🐳 Docker

### Build Image

```bash
docker build -t email-kanban-backend .
```

### Run with Docker Compose

```bash
docker-compose up -d
```

Services included:

- **mongodb**: MongoDB 7 database
- **qdrant**: Qdrant vector database

## 🔐 Google Cloud Setup

1. Create OAuth 2.0 Client ID (Web application) in Google Cloud Console
2. Add authorized JavaScript origins:
   - `http://localhost:5173` (development)
   - Your production domain
3. Enable Gmail API in the project
4. (Optional) Set up Pub/Sub topic for push notifications

## 📁 Project Structure

```
src/
├── ai/                 # AI services (OpenAI, Qdrant)
│   ├── ai.module.ts
│   ├── ai.service.ts   # Email summarization, embeddings
│   └── qdrant.service.ts # Vector database operations
├── auth/               # Authentication
│   ├── auth.controller.ts
│   ├── auth.service.ts # JWT token management
│   ├── google-auth.service.ts # OAuth code exchange
│   ├── guards/         # JWT guard
│   └── strategies/     # Passport JWT strategy
├── common/             # Shared utilities
│   ├── decorators/     # @CurrentUser decorator
│   ├── dtos/           # API response DTOs
│   ├── filters/        # Exception filters
│   └── interceptors/   # Response transform
├── gmail-push/         # Real-time notifications
│   ├── gmail-push.controller.ts # Watch start/stop
│   ├── gmail-push.service.ts    # Pub/Sub processing
│   ├── gmail-push.gateway.ts    # WebSocket gateway
│   └── gmail-push.cron.ts       # Watch renewal
├── health/             # Health check
├── kanban/             # Kanban board
│   ├── kanban.controller.ts
│   ├── kanban.service.ts # Board logic, search, AI
│   ├── kanban.cron.ts    # Snooze wake-up
│   └── schemas/          # EmailItem schema
├── mail/               # Email operations
│   ├── mail.controller.ts
│   ├── mail.service.ts   # Gmail API integration
│   └── dtos/             # Request/Response DTOs
├── scripts/            # Utility scripts
│   └── generate-embeddings.ts
└── users/              # User management
    ├── users.service.ts
    └── schemas/        # User, UserSettings schemas
```

## 🔒 Security Considerations

- **Access Token**: Short-lived (15m), returned in response body, stored in-memory on frontend
- **Refresh Token**: Long-lived (7d), stored in HttpOnly cookie (Secure, SameSite=Strict) + bcrypt hash in DB
- **Cookie Security**: HttpOnly (no JS access), Secure (HTTPS only in production), SameSite=Strict (CSRF protection)
- **Gmail Refresh Token**: Encrypted storage in MongoDB, never exposed to frontend
- **OAuth Flow**: Authorization Code (not Implicit) for security
- **CORS**: Strict origin validation with credentials support
- **Input Validation**: Class-validator DTOs on all endpoints

## 📝 License

MIT
