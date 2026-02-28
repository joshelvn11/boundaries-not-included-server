import { Router } from "express";

const SERVICE_NAME = "boundaries-not-included-server";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: SERVICE_NAME,
    time: new Date().toISOString()
  });
});
