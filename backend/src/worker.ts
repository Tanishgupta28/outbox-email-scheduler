import { Worker, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { db, type Email } from "./db.js";
import { queue, redis, startReconciler } from "./queue.js";
import { deliver } from "./mail.js";
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", () =>
  console.error("Worker Redis connection unavailable."),
);
const worker = new Worker(
  config.QUEUE_NAME,
  async (job) => {
    const sql = await db.getConnection();
    const lock = `outbox-${job.data.emailId}`;
    let locked = false;
    try {
      const [locks]: any = await sql.query("SELECT GET_LOCK(?,0) AS acquired", [
        lock,
      ]);
      locked = locks[0].acquired === 1;
      if (!locked) throw new Error("Email is already being processed");
      const [rows] = await sql.query<Email[]>(
        "SELECT * FROM emails WHERE id=?",
        [job.data.emailId],
      );
      const email = rows[0];
      if (!email || email.status === "sent" || email.status === "failed")
        return;
      if (email.scheduled_at.getTime() > Date.now())
        throw new Error("Schedule is not due yet");
      if (email.attempts >= config.MAX_ATTEMPTS) {
        await sql.query(
          "UPDATE emails SET status='failed',last_error='Attempt budget exhausted; prior SMTP outcome may be unknown.' WHERE id=?",
          [email.id],
        );
        throw new UnrecoverableError("Attempt budget exhausted");
      }
      await sql.query(
        "UPDATE emails SET status='processing',attempts=attempts+1 WHERE id=?",
        [email.id],
      );
      try {
        const preview = await deliver(email);
        await sql.query(
          "UPDATE emails SET status='sent',sent_at=UTC_TIMESTAMP(3),preview_url=?,last_error=NULL WHERE id=?",
          [preview, email.id],
        );
        console.log(`SMTP accepted email ${email.id}`);
      } catch (error) {
        const exhausted = email.attempts + 1 >= config.MAX_ATTEMPTS;
        // Do not expose SMTP credentials or server responses in API errors.
        await sql.query("UPDATE emails SET status=?,last_error=? WHERE id=?", [
          exhausted ? "failed" : "scheduled",
          exhausted
            ? "Delivery failed after maximum attempts; SMTP outcome may be unknown."
            : "Delivery attempt failed; retry pending.",
          email.id,
        ]);
        throw new Error("Delivery attempt failed");
      }
    } finally {
      if (locked) await sql.query("SELECT RELEASE_LOCK(?)", [lock]);
      sql.release();
    }
  },
  {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    limiter: {
      max: config.RATE_LIMIT_MAX,
      duration: config.RATE_LIMIT_DURATION_MS,
    },
    maxStalledCount: 1,
  },
);
worker.on("error", () =>
  console.error("Worker error; inspect service health."),
);
worker.on("failed", (job) => console.error(`Job ${job?.id} attempt failed`));
const stopReconciler = startReconciler();
console.log(
  `Worker ready: concurrency=${config.WORKER_CONCURRENCY}, rate=${config.RATE_LIMIT_MAX}/${config.RATE_LIMIT_DURATION_MS}ms, transport=${config.MAIL_TRANSPORT}`,
);
async function shutdown() {
  stopReconciler();
  await worker.close();
  await queue.close();
  await redis.quit();
  await connection.quit();
  await db.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
