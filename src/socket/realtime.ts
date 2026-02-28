import type { Server as SocketIOServer } from "socket.io";

import type { RoomLifecycleService } from "../services/room-lifecycle.service";

type SocketAuthPayload = {
  roomCode?: string;
  playerId?: string;
  reconnectToken?: string;
};

export function setupRealtime(io: SocketIOServer, roomService: RoomLifecycleService): void {
  roomService.setBroadcastHook(async (roomCode) => {
    const identities = roomService.listSocketIdentitiesForRoom(roomCode);

    for (const identity of identities) {
      try {
        const snapshot = roomService.getSnapshotForPlayer(identity.roomCode, identity.playerId);
        io.to(identity.socketId).emit("room:state", snapshot);
      } catch {
        io.to(identity.socketId).emit("error", {
          error: "UNAUTHORIZED",
          message: "Session no longer valid for room"
        });
      }
    }
  });

  io.on("connection", (socket) => {
    const auth = (socket.handshake.auth ?? {}) as SocketAuthPayload;

    if (!auth.roomCode || !auth.playerId || !auth.reconnectToken) {
      socket.emit("error", {
        error: "UNAUTHORIZED",
        message: "Missing socket authentication payload"
      });
      socket.disconnect(true);
      return;
    }

    try {
      const snapshot = roomService.attachSocket(
        socket.id,
        auth.roomCode,
        auth.playerId,
        auth.reconnectToken
      );

      socket.join(auth.roomCode.toUpperCase());
      socket.emit("room:state", snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Socket authentication failed";
      socket.emit("error", {
        error: "UNAUTHORIZED",
        message
      });
      socket.disconnect(true);
      return;
    }

    socket.on("disconnect", () => {
      roomService.detachSocket(socket.id);
    });
  });
}
