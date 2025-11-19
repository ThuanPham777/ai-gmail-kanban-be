# User Registration System - Backend

NestJS + MongoDB + JWT backend for user registration and authentication.

## Prerequisites

- Node.js 20.0+ (or 22.x)
- npm (or yarn/pnpm)
- MongoDB (local or Atlas)

## Install

```bash
cd user-registration-be
npm install
```

## Environment (.env)

Create `.env` in `user-registration-be`:

```env
MONGODB_URI=mongodb://localhost:27017/user-registration
PORT=4000
JWT_ACCESS_SECRET=replace-with-strong-secret
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
CORS_ORIGIN=http://localhost:5173
```

Notes:
- `PORT` defaults to 4000 if unset.
- `MONGODB_URI` is required.

## Run

Development (watch):
```bash
npm run start:dev
```

Production (build then run):
```bash
npm run build && npm run start:prod
```

API base URL (local): `http://localhost:4000`

Public URL: `https://user-registration-be-uibn.onrender.com`

## API Routes (summary)

- POST `/user/register` — create account
- POST `/user/login` — returns `accessToken`, `refreshToken`, `user`
- POST `/user/refresh` — exchange `userId` + `refreshToken` for new tokens
- POST `/user/logout` — revoke refresh token

## Docker (optional)

Run MongoDB locally with Docker:
```bash
docker run -d --name mongodb -p 27017:27017 mongo
```