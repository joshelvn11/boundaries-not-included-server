import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError } from "zod";

import { ApiError } from "./errors/api-error";
import type { RoomLifecycleService } from "./services/room-lifecycle.service";
import type { AppEnv } from "./config/env";
import { healthRouter } from "./routes/health";
import { openapiRouter } from "./routes/openapi";
import { createRoomsRouter } from "./routes/rooms";

type AppDependencies = {
  roomService?: RoomLifecycleService;
};

export function createApp(env: AppEnv, dependencies: AppDependencies = {}) {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN
    })
  );
  app.use(express.json());

  app.use(healthRouter);
  app.use(openapiRouter);

  if (dependencies.roomService) {
    app.use(createRoomsRouter(dependencies.roomService));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message
      });
      return;
    }

    if (error instanceof ZodError) {
      res.status(422).json({
        error: "VALIDATION_ERROR",
        message: error.issues.map((issue) => issue.message).join("; ")
      });
      return;
    }

    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Unexpected server error"
    });
  });

  return app;
}
