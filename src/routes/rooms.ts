import { Router, type NextFunction, type Request, type Response } from "express";

import { requireRoomAuth } from "../middleware/auth";
import type { RoomLifecycleService } from "../services/room-lifecycle.service";

function handle(
  fn: (req: Request, res: Response, next: NextFunction) => void
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function createRoomsRouter(roomService: RoomLifecycleService): Router {
  const router = Router();

  router.get(
    "/packs",
    handle((_req, res) => {
      const result = roomService.listPacks();
      res.status(200).json(result);
    })
  );

  router.post(
    "/rooms",
    handle((req, res) => {
      const payload = roomService.validateCreatePayload(req.body);
      const result = roomService.createRoom(payload);

      res.status(201).json({
        roomCode: result.roomCode,
        playerId: result.playerId,
        reconnectToken: result.reconnectToken,
        snapshot: result.snapshot
      });
    })
  );

  router.post(
    "/rooms/:code/join",
    handle((req, res) => {
      const payload = roomService.validateJoinPayload(req.body);
      const result = roomService.joinRoom(req.params.code, payload);

      res.status(200).json({
        roomCode: result.roomCode,
        playerId: result.playerId,
        reconnectToken: result.reconnectToken,
        snapshot: result.snapshot
      });
    })
  );

  router.post(
    "/rooms/:code/reconnect",
    handle((req, res) => {
      const payload = roomService.validateReconnectPayload(req.body);
      const result = roomService.reconnect(req.params.code, payload);

      res.status(200).json({
        playerId: result.playerId,
        reconnectToken: result.reconnectToken,
        snapshot: result.snapshot
      });
    })
  );

  router.get(
    "/rooms/:code",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const snapshot = roomService.getSnapshotForPlayer(auth.roomCode, auth.playerId);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/ready",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const payload = roomService.validateReadyPayload(req.body);
      const snapshot = roomService.setReady(auth, payload);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/start",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const snapshot = roomService.startGame(auth);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/play-again",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const snapshot = roomService.playAgain(auth);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/submit",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const payload = roomService.validateSubmitPayload(req.body);
      const snapshot = roomService.submitCard(auth, payload);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/pick-winner",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const payload = roomService.validatePickPayload(req.body);
      const snapshot = roomService.pickWinner(auth, payload);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/next-round",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      const snapshot = roomService.startNextRound(auth);
      res.status(200).json(snapshot);
    })
  );

  router.post(
    "/rooms/:code/leave",
    requireRoomAuth(roomService),
    handle((req, res) => {
      const auth = req.roomAuth;
      if (!auth) {
        throw new Error("Room auth context missing");
      }

      roomService.leaveRoom(auth);
      res.status(204).send();
    })
  );

  return router;
}
