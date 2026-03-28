# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Added `Dockerfile`, `.dockerignore`, and `docker-compose.yml` to run the server in a container with a named volume for SQLite (`/data/bni.sqlite`), documented in README and TECHNICAL.
- Added Phase 2 room/game REST API: create, join, reconnect, ready, start, submit, pick-winner, leave, and snapshot retrieval.
- Added token-based room session management with hashed reconnect tokens (`room_sessions`).
- Added player hand persistence table (`player_hands`) and hand-card submission model.
- Added game engine service for round transitions, judge rotation, winner selection, and score-based game completion.
- Added personalized snapshot service for REST and socket state fan-out.
- Added socket realtime bridge with authenticated handshake and `room:state` broadcasts.
- Added Phase 2 migration for new tables, columns, and indexes.
- Added integration tests for room lifecycle, auth failures, submission validation, round progression, and socket handshake behavior.
- Added `POST /rooms/:code/play-again` host-only endpoint to reset a completed game back to lobby for another ready-up cycle.
- Added Phase 6 migration `0002_phase6_play_again.sql` with `games.archived_at` and supporting index.
- Added server integration coverage for play-again happy path, forbidden access, invalid state, migration column presence, and socket snapshot fan-out.
- Added Phase 7 migration `0003_phase7_multi_pick.sql` with `rounds.pick_count_required` and grouped submission columns/indexes.
- Added grouped multi-card submission support (up to 3 cards) using `handCardIds[]` and `submission_group_id`.
- Added server test coverage for two-blank exact submit requirements, no-blank default pick count, >3-blank prompt skipping, start failure with only unplayable prompts, and grouped winner scoring.
- Added `POST /rooms/:code/next-round` for judge-driven transition from `ROUND_RESULTS` to the next round.
- Added server integration coverage for round-results snapshots, judge-only next-round authorization, invalid-state handling, and not-enough-connected-player game-over behavior at next-round time.
- Added socket coverage for `room:state` emissions on `pick-winner -> ROUND_RESULTS` and `next-round -> ROUND_SUBMIT`.
- Added `GET /packs` endpoint for playable pack catalog with active white/black counts.
- Added server integration coverage for pack catalog, pack validation on create, selected-pack gameplay filtering, and legacy pack fallback behavior.

### Changed

- Extended game schema with `target_score` and `ended_reason`.
- Extended game schema with nullable `archived_at` marker so completed games can be hidden from active snapshots without data deletion.
- Extended submission schema with `reveal_order`.
- Updated app-level error handling to standardized `{ error, message }` responses.
- Expanded OpenAPI spec to include full Phase 2 contract.
- Expanded OpenAPI spec with `POST /rooms/{code}/play-again`.
- Updated snapshot builder to read only latest unarchived game row per room.
- Updated server README/TECHNICAL docs for Phase 2 behavior and interfaces.
- Updated `/rooms/:code/submit` contract from single `handCardId` to ordered `handCardIds[]`.
- Updated round prompt selection to derive effective pick count from underscore blank groups (`_+`) and skip prompts requiring more than 3 picks.
- Updated snapshot submission payloads to include ordered `answerCards` and a filled-sentence `text` preview for judge/results/game-over views.
- Updated non-terminal `pick-winner` behavior to stop in `ROUND_RESULTS` instead of auto-starting the next round.
- Updated round progression to require current judge action (`POST /rooms/:code/next-round`) before advancing from results.
- Updated room settings to persist `packs: string[]` and include pack selection in snapshots.
- Updated create-room validation to reject unknown pack names and to default omitted packs to all playable packs.
- Updated game engine card-pool selection to filter white/black cards by room-selected packs.

### Fixed

- Ensured connection-level SQLite foreign keys are enabled at runtime.
- Fixed migration execution to run `drizzle/*.sql` directly with SQLite-backed tracking, removing the `meta/_journal.json` runtime requirement.
- Fixed server typecheck in environments without `@types/supertest` by adding a local module declaration for test imports.
- Fixed intermittent integration test instability by closing SQLite connections in `rooms` and `socket` test teardown.
