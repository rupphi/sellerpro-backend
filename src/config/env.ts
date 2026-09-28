import "dotenv/config";
import { z } from "zod";
export const env = z
    .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default("redis://localhost:6389"),
    CREDENTIALS_KEY: z
        .string()
        .regex(/^[a-f0-9]{64}$/i, "CREDENTIALS_KEY must be 32 bytes in hex"),
    APP_ORIGIN: z.string().url().default("http://localhost:3000"),
    PORT: z.coerce.number().default(4000),
    HOST: z.string().default("127.0.0.1"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    NODE_ENV: z.string().default("development"),
})
    .parse(process.env);
