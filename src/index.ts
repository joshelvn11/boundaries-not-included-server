import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";

import { createApp } from "./app";
import { loadEnv } from "./config/env";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { RoomLifecycleService } from "./services/room-lifecycle.service";
import { setupRealtime } from "./socket/realtime";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  await runMigrations(env.BNI_SQLITE_PATH);

  const { connection } = createDb(env.BNI_SQLITE_PATH);
  const roomService = new RoomLifecycleService(connection);

  const app = createApp(env, { roomService });
  const server = createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: env.CORS_ORIGIN
    }
  });

  setupRealtime(io, roomService);

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server", error);
  process.exit(1);
});
