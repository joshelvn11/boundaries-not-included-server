import fs from "fs";
import os from "os";
import path from "path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0, createdFiles.length)) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }
});

describe("runMigrations", () => {
  it("creates all core tables and phase 6 game archive column", async () => {
    const tempDbPath = path.join(os.tmpdir(), `bni-test-${Date.now()}.sqlite`);
    createdFiles.push(tempDbPath);

    await runMigrations(tempDbPath, path.resolve(process.cwd(), "drizzle"));

    const db = new Database(tempDbPath, { readonly: true });
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const gameColumns = db
      .prepare("PRAGMA table_info(games)")
      .all() as Array<{ name: string }>;

    db.close();

    const tableNames = rows.map((row) => row.name);
    const expectedCoreTables = [
      "black_cards",
      "games",
      "player_hands",
      "players",
      "room_players",
      "room_sessions",
      "rooms",
      "round_submissions",
      "rounds",
      "white_cards"
    ];

    for (const tableName of expectedCoreTables) {
      expect(tableNames).toContain(tableName);
    }

    expect(tableNames.some((name) => name.includes("drizzle_migrations"))).toBe(true);
    expect(gameColumns.map((column) => column.name)).toContain("archived_at");
  });
});
