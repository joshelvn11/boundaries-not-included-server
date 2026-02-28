import type Database from "better-sqlite3";

import { ApiError } from "../errors/api-error";
import { LIMITS } from "../types/domain";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ATTEMPTS = 64;

function randomRoomCode(length: number): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    const charIndex = Math.floor(Math.random() * ALPHABET.length);
    code += ALPHABET[charIndex];
  }
  return code;
}

export function generateUniqueRoomCode(connection: Database.Database): string {
  const selectRoom = connection.prepare("SELECT 1 FROM rooms WHERE code = ? LIMIT 1");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = randomRoomCode(LIMITS.roomCodeLength);
    const existing = selectRoom.get(code);
    if (!existing) {
      return code;
    }
  }

  throw new ApiError(500, "INTERNAL_ERROR", "Unable to allocate a unique room code");
}
