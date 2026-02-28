# TODO

- [TECH DEBT] Remove schema duplication between Drizzle schema (`src/db/schema.ts`) and raw SQL migrations (`drizzle/*.sql`) in `/Users/joshbeaver/Documents/Projects/boundaries-not-included/boundaries-not-included-server`.
  Why: maintaining two schema definitions increases drift risk as Phase 2+ schema evolves.
  Suggested approach: make Drizzle schema authoritative and generate migration SQL from it in CI/local workflow.

- [TECH DEBT] Persist disconnect grace timers outside process memory in `/Users/joshbeaver/Documents/Projects/boundaries-not-included/boundaries-not-included-server/src/services/room-lifecycle.service.ts`.
  Why: current timer map is in-memory and is lost on server restart.
  Suggested approach: store disconnect deadline timestamps in DB and run periodic reconciliation on startup/runtime.
