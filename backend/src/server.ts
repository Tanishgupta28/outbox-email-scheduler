import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ResultSetHeader } from "mysql2/promise";
import { config } from "./config.js";
import { db, emails } from "./db.js";
import { verifyPassword, tokenHash } from "./auth.js";
import {
  enqueue,
  removeQueuedEmail,
  queue,
  redis,
  startReconciler,
} from "./queue.js";
const app = express();
app.use(helmet(), express.json({ limit: "32kb" }), cookieParser());
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.get("origin") &&
    req.get("origin") !== config.APP_ORIGIN
  )
    return res.status(403).json({ error: "Origin not allowed" });
  next();
});
app.get("/api/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.NODE_ENV === "production",
  path: "/",
};
app.post(
  "/api/login",
  rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
  async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Enter a valid email and password" });
    const [rows]: any = await db.query("SELECT * FROM users WHERE email=?", [
      parsed.data.email,
    ]);
    const user = rows[0];
    if (!user || !verifyPassword(parsed.data.password, user.password_hash))
      return res.status(401).json({ error: "Invalid login" });
    const token = randomBytes(32).toString("hex");
    await db.query("DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3)");
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))",
      [tokenHash(token), user.id],
    );
    res
      .cookie("outbox_session", token, { ...cookieOptions, maxAge: 86400000 })
      .json({ id: user.id, name: user.name, email: user.email });
  },
);
app.use("/api", async (req, res, next) => {
  const token = req.cookies.outbox_session;
  if (!token) return res.status(401).json({ error: "Please log in" });
  const [rows]: any = await db.query(
    "SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(3)",
    [tokenHash(token)],
  );
  if (!rows.length) return res.status(401).json({ error: "Session expired" });
  res.locals.user = rows[0];
  next();
});
app.get("/api/me", (_req, res) => res.json(res.locals.user));
app.post("/api/logout", async (req, res) => {
  await db.query("DELETE FROM sessions WHERE token_hash=?", [
    tokenHash(req.cookies.outbox_session),
  ]);
  res.clearCookie("outbox_session", cookieOptions).sendStatus(204);
});
app.get("/api/emails", async (_req, res) =>
  res.json(
    await emails(
      "SELECT * FROM emails WHERE user_id=? ORDER BY created_at DESC",
      [res.locals.user.id],
    ),
  ),
);
app.post("/api/emails/:id/cancel", async (req, res) => {
  // This update and the worker's claim compete for the same InnoDB row lock.
  // Once any send attempt starts, its SMTP outcome could be unknown: do not
  // promise cancellation even if that attempt later returns to retry pending.
  const [result] = await db.query<ResultSetHeader>(
    "UPDATE emails SET status='cancelled',last_error=NULL WHERE id=? AND user_id=? AND status='scheduled' AND attempts=0",
    [req.params.id, res.locals.user.id],
  );
  if (!result.affectedRows) {
    const [email] = await emails(
      "SELECT * FROM emails WHERE id=? AND user_id=?",
      [req.params.id, res.locals.user.id],
    );
    if (!email) return res.status(404).json({ error: "Email not found" });
    if (email.status !== "cancelled")
      return res
        .status(409)
        .json({
          error:
            "It is too late to cancel this email; delivery has already started or finished.",
        });
  }
  // Durable cancellation is already committed. Redis cleanup is best effort;
  // retained or active jobs still have to pass the worker's database claim.
  try {
    await removeQueuedEmail(req.params.id);
  } catch {
    console.error(
      "Cancelled email queue cleanup unavailable; database guard remains active.",
    );
  }
  res.json({ id: req.params.id, status: "cancelled" });
});
const scheduleSchema = z.object({
  recipient: z.email().max(254),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  scheduledAt: z.iso.datetime({ offset: true }),
});
app.post(
  "/api/emails",
  rateLimit({ windowMs: 60000, limit: 60 }),
  async (req, res) => {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error:
          "Enter a valid recipient, subject, body and ISO date with a time zone",
      });
    const { recipient, subject, body, scheduledAt } = parsed.data;
    const scheduled = new Date(scheduledAt);
    if (scheduled.getTime() <= Date.now())
      return res
        .status(400)
        .json({ error: "Delivery time must be in the future" });
    if (scheduled.getTime() > Date.now() + 366 * 86400000)
      return res.status(400).json({ error: "Schedule within the next year" });
    const id = randomUUID();
    await db.query(
      "INSERT INTO emails(id,user_id,recipient,subject,body,scheduled_at) VALUES(?,?,?,?,?,?)",
      [id, res.locals.user.id, recipient, subject, body, scheduled],
    );
    const [email] = await emails("SELECT * FROM emails WHERE id=?", [id]);
    let queuePending = false;
    try {
      await enqueue(email);
    } catch {
      queuePending = true;
    }
    res.status(201).json({ ...email, queuePending });
  },
);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use(express.static(resolve("dist/web")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(resolve("dist/web/index.html")),
);
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Request failed");
    res.status(500).json({
      error: "Service temporarily unavailable; please refresh before retrying",
    });
  },
);
const stopReconciler = startReconciler();
const server = app.listen(config.PORT, () =>
  console.log(`API listening on ${config.PORT}`),
);
async function shutdown() {
  stopReconciler();
  server.close(async () => {
    await queue.close();
    await redis.quit();
    await db.end();
    process.exit(0);
  });
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
