# Technical Notes - Server

## Architecture

### Startup flow

1. Validate environment variables (`src/config/env.ts`).
2. Apply migrations (`src/db/migrate.ts`).
3. Create runtime SQLite connection (`src/db/client.ts`).
4. Construct room/game lifecycle service (`src/services/room-lifecycle.service.ts`).
5. Build Express app routes (`src/app.ts`).
6. Attach Socket.IO and realtime bridge (`src/socket/realtime.ts`).

### Migration runner

- The server applies SQL files from `drizzle/*.sql` in lexical order.
- Applied files are tracked in `drizzle_migrations` (`name`, `applied_at`) to keep migrations idempotent.
- This runner does not require Drizzle's `meta/_journal.json`; migration state is stored inside SQLite.

## Configuration

Environment variables:

- `PORT` (default `4000`)
- `CORS_ORIGIN` (default `*`)
- `BNI_SQLITE_PATH` (default `./data/bni.sqlite`)

## Data model

### Existing core tables

- `rooms`
- `players`
- `room_players`
- `games`
- `rounds`
- `round_submissions`
- `white_cards`
- `black_cards`

### Phase 2 additions

- `room_sessions`
  - Stores hashed reconnect token per room/player.
  - Active session rows are `revoked_at IS NULL`.

- `player_hands`
  - Stores each player's hand cards for a room.
  - `id` is the `handCardId` used by submit API.

- `games`
  - Added `target_score`, `ended_reason`.
  - Added nullable `archived_at` marker for completed-game archival.

- `round_submissions`
  - Added `reveal_order` for anonymized reveal sorting.

## Services

### `room-lifecycle.service.ts`

High-level orchestrator for:

- create/join/reconnect
- auth/session validation
- ready/start/play-again/submit/pick-winner/leave
- disconnect grace removal and host reassignment
- socket identity tracking per connection

### `game-engine.service.ts`

Game state transitions:

- start game
- deal hands
- accept submissions
- transition submit -> judge pick
- apply winner and score updates
- rotate judge and create next round
- end game on target score or insufficient players

### `snapshot.service.ts`

Builds personalized `room:state` payload:

- private hand visible only to requesting player
- anonymized submissions during judge-pick phase
- player identity + winner details revealed in results/game-over
- only the latest unarchived game row is considered active for snapshot rendering

## REST layer

`src/routes/rooms.ts` contains all room/game command endpoints.

Auth middleware (`src/middleware/auth.ts`) validates:

- room code path parameter
- `x-player-id`
- bearer reconnect token

On success, request receives `req.roomAuth` context.

Error contract is standardized in `src/app.ts`:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message"
}
```

## Realtime layer

`src/socket/realtime.ts`:

- validates socket handshake credentials using room lifecycle service
- binds socket to room and emits personalized snapshot
- handles disconnect -> marks player disconnected and starts grace timer
- broadcasts full personalized snapshots to each connected socket after mutating operations

## Core gameplay rules (implemented)

- room code format: 6 uppercase letters
- reconnect grace: 90 seconds
- minimum players to start: 3 connected
- all connected players must be ready to start
- no submit timer, no judge timer
- no host override for judge decision
- mid-game joins blocked
- host can reset `GAME_OVER` back to lobby via `POST /rooms/:code/play-again`; reset clears ready state, scores, and hands

## Testing

- `health.test.ts`: health route response shape
- `migrate.test.ts`: verifies migrated tables
- `rooms.test.ts`: REST lifecycle and round flow integration
- `socket.test.ts`: handshake success/failure and initial state emission
- Integration tests explicitly close their SQLite connections in `afterEach` to avoid cross-test resource leakage and flaky request failures.

## Contract ownership

OpenAPI source of truth remains:

- `openapi/openapi.yaml`

App generated types must be refreshed from this file.
