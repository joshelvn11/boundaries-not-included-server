import fs from "fs";
import path from "path";
import { Router } from "express";

export const openapiRouter = Router();

const openApiPath = path.resolve(process.cwd(), "openapi", "openapi.yaml");

openapiRouter.get("/openapi.yaml", (_req, res) => {
  try {
    const raw = fs.readFileSync(openApiPath, "utf8");
    res.type("text/yaml").status(200).send(raw);
  } catch {
    res.status(500).json({
      error: "OPENAPI_NOT_FOUND",
      message: "openapi/openapi.yaml is missing"
    });
  }
});
