import "dotenv/config";
import { z } from "zod";
const positive = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);
export const config = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: positive(3001),
    APP_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url(),
    QUEUE_NAME: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default("outbox-email"),
    WORKER_CONCURRENCY: positive(3),
    RATE_LIMIT_MAX: positive(2),
    RATE_LIMIT_DURATION_MS: positive(10000),
    MAX_ATTEMPTS: positive(3),
    RETRY_DELAY_MS: positive(2000),
    RECONCILE_INTERVAL_MS: positive(3000),
    MAIL_TRANSPORT: z.enum(["ethereal", "fake"]).default("ethereal"),
    SMTP_HOST: z.literal("smtp.ethereal.email").default("smtp.ethereal.email"),
    SMTP_PORT: positive(587),
    SMTP_USER: z.string().default(""),
    SMTP_PASS: z.string().default(""),
    MAIL_FROM: z.string().default("Outbox Demo <demo@outbox.example>"),
    DEMO_PASSWORD: z.string().min(12).default("OutboxDemo2026!"),
  })
  .parse(process.env);
if (config.MAIL_TRANSPORT === "fake" && config.NODE_ENV !== "test")
  throw new Error("Fake transport is restricted to NODE_ENV=test");
