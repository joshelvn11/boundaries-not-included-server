import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app";

const env = {
  PORT: 4000,
  CORS_ORIGIN: "*",
  BNI_SQLITE_PATH: ":memory:"
};

describe("GET /health", () => {
  it("returns the expected health payload", async () => {
    const app = createApp(env);

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("boundaries-not-included-server");
    expect(new Date(response.body.time).toString()).not.toBe("Invalid Date");
  });
});
