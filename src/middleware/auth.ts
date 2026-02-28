import type { NextFunction, Request, Response } from "express";

import { ApiError } from "../errors/api-error";
import type { RoomLifecycleService } from "../services/room-lifecycle.service";

function parseBearerToken(rawHeader: string | undefined): string | null {
  if (!rawHeader) {
    return null;
  }

  const [prefix, token] = rawHeader.split(" ");
  if (prefix !== "Bearer" || !token) {
    return null;
  }

  return token;
}

export function requireRoomAuth(roomService: RoomLifecycleService) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const roomCode = String(req.params.code ?? "").toUpperCase();
      const playerId = String(req.header("x-player-id") ?? "").trim();
      const token = parseBearerToken(req.header("authorization"));

      if (!roomCode || !playerId || !token) {
        throw new ApiError(401, "UNAUTHORIZED", "Missing authentication headers");
      }

      req.roomAuth = roomService.authenticateRequest(roomCode, playerId, token);
      next();
    } catch (error) {
      next(error);
    }
  };
}
