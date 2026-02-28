import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export function createSqliteConnection(sqlitePath: string): Database.Database {
  const dir = path.dirname(sqlitePath);
  fs.mkdirSync(dir, { recursive: true });
  const connection = new Database(sqlitePath);
  connection.pragma("foreign_keys = ON");
  return connection;
}

export function createDb(sqlitePath: string) {
  const connection = createSqliteConnection(sqlitePath);
  const db = drizzle(connection, { schema });
  return { db, connection };
}
