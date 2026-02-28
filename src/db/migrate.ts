import path from "path";
import fs from "fs";

import { createSqliteConnection } from "./client";
import { loadEnv } from "../config/env";

export async function runMigrations(
  sqlitePath: string,
  migrationsFolder = path.resolve(process.cwd(), "drizzle")
): Promise<void> {
  const connection = createSqliteConnection(sqlitePath);
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);

    const migrationFiles = fs
      .readdirSync(migrationsFolder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const applied = new Set(
      (
        connection.prepare("SELECT name FROM drizzle_migrations ORDER BY id ASC").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );

    for (const fileName of migrationFiles) {
      if (applied.has(fileName)) {
        continue;
      }

      const migrationSql = fs.readFileSync(path.join(migrationsFolder, fileName), "utf8").trim();

      connection.transaction(() => {
        if (migrationSql.length > 0) {
          connection.exec(migrationSql);
        }

        connection
          .prepare("INSERT INTO drizzle_migrations (name, applied_at) VALUES (?, ?)")
          .run(fileName, new Date().toISOString());
      })();
    }
  } finally {
    connection.close();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  await runMigrations(env.BNI_SQLITE_PATH);
  // eslint-disable-next-line no-console
  console.log(`Migrations applied to ${env.BNI_SQLITE_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
