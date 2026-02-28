# Boundaries Not Included - Server

Express + SQLite + Drizzle backend for room/game orchestration.

## Requirements

- Node.js 20.x
- pnpm 9+

## Setup

```bash
pnpm install
cp .env.example .env
```

## Commands

```bash
pnpm dev         # run server in watch mode
pnpm build       # compile TypeScript
pnpm start       # run built server
pnpm test        # run Vitest tests
pnpm typecheck   # strict TS checks
pnpm db:migrate  # apply SQL migrations
```

## Environment

- `PORT` (default `4000`)
- `CORS_ORIGIN` (default `*`)
- `BNI_SQLITE_PATH` (default `./data/bni.sqlite`)

## REST API (Phase 2)

- `GET /health`
- `GET /openapi.yaml`
- `POST /rooms`
- `POST /rooms/:code/join`
- `POST /rooms/:code/reconnect`
- `GET /rooms/:code`
- `POST /rooms/:code/ready`
- `POST /rooms/:code/start`
- `POST /rooms/:code/play-again`
- `POST /rooms/:code/submit`
- `POST /rooms/:code/pick-winner`
- `POST /rooms/:code/leave`

Phase 7 submit payload:

- `POST /rooms/:code/submit` now accepts `{ "handCardIds": ["hand_a", "hand_b"] }`
- Required card count is derived from black-card underscore blanks per round (`0 -> 1`, `1..3 -> exact`, `>3` prompts skipped)

Authenticated endpoints require:

- `x-player-id: <playerId>`
- `authorization: Bearer <reconnectToken>`

## Realtime

Socket.IO is enabled and expects auth payload on connect:

```json
{
  "roomCode": "ABCDEF",
  "playerId": "plr_x",
  "reconnectToken": "..."
}
```

Events:

- `room:state` (personalized full snapshot)
- `error` (socket auth/session issues)

## Database

SQLite schema includes room/game tables plus Phase 2 session and hand state:

- `room_sessions`
- `player_hands`

Run populator before starting a game so `white_cards` and `black_cards` are populated.
