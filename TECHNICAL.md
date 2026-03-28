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
  - Added `submission_group_id` and `card_order` for multi-card submissions stored as grouped rows.

- `rounds`
  - Added `pick_count_required` for effective per-round submit requirements.

## Services

### `room-lifecycle.service.ts`

High-level orchestrator for:

- create/join/reconnect
- pack catalog listing (`GET /packs`)
- auth/session validation
- ready/start/play-again/submit/pick-winner/next-round/leave
- disconnect grace removal and host reassignment
- socket identity tracking per connection

Create-room pack rules:

- room settings now persist `packs: string[]` in `rooms.settings_json`.
- if caller supplies `settings.packs`, values must be unique and must exist in current playable pack catalog.
- if caller omits `settings.packs`, service resolves to all currently playable packs for backward compatibility.
- playable pack catalog is computed from active cards:
  - white count > 0
  - playable black count > 0 (black prompts with inferred pick count 1..3)

### `game-engine.service.ts`

Game state transitions:

- start game
- deal hands
- accept grouped submissions (`handCardIds[]`) with exact count validation
- transition submit -> judge pick
- apply winner and score updates
- transition to explicit `ROUND_RESULTS` for non-terminal rounds
- start next round only when the current round judge calls next-round action
- end game on target score or insufficient players
- derives per-round pick count from black prompt text underscores (`_+`):
  - 0 blanks => pick count 1
  - 1..3 blanks => exact blank count
  - >3 blanks => prompt skipped as unplayable
- applies room-selected pack filters when:
  - validating card pool availability at game start
  - selecting black prompts
  - dealing white cards to player hands

### `snapshot.service.ts`

Builds personalized `room:state` payload:

- private hand visible only to requesting player
- anonymized submissions during judge-pick phase
- player identity + winner details revealed in results/game-over
- only the latest unarchived game row is considered active for snapshot rendering
- submission rows are grouped by `submission_group_id` into snapshot submissions with:
  - `submissionId` (group id)
  - `answerCards` (ordered card texts)
  - `text` (filled prompt sentence fallback)

## REST layer

`src/routes/rooms.ts` contains all room/game command endpoints.

Additional read endpoint:

- `GET /packs` returns playable packs for create-room multiselect:
  - `{ packs: [{ name, whiteCount, blackCount }] }`

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
- per-round pick count derives from prompt blank count (max supported picks: 3)
- no submit timer, no judge timer
- no host override for judge decision
- mid-game joins blocked
- non-terminal round progression is judge-controlled (`pick-winner` -> `ROUND_RESULTS` -> judge `next-round`)
- host can reset `GAME_OVER` back to lobby via `POST /rooms/:code/play-again`; reset clears ready state, scores, and hands

## Testing

- `health.test.ts`: health route response shape
- `migrate.test.ts`: verifies migrated tables
- `rooms.test.ts`: REST lifecycle and round flow integration
- `socket.test.ts`: handshake success/failure and initial state emission
- phase coverage includes multi-pick validation, blank-count prompt policy, unplayable-prompt start guard, grouped winner scoring, explicit round-results snapshots, judge-only next-round progression, and existing play-again lifecycle.
- Integration tests explicitly close their SQLite connections in `afterEach` to avoid cross-test resource leakage and flaky request failures.

## Contract ownership

OpenAPI source of truth remains:

- `openapi/openapi.yaml`

App generated types must be refreshed from this file.
