import path from "path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  BNI_SQLITE_PATH: z
    .string()
    .min(1)
    .default(path.resolve(process.cwd(), "data", "bni.sqlite")),
  CORS_ORIGIN: z.string().min(1).default("*")
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}
