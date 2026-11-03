import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { db, emails, type Email } from "./db.js";
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 2000,
});
redis.on("error", () => {});
export const queue = new Queue(config.QUEUE_NAME, { connection: redis });
queue.on("error", () => {});
export async function enqueue(email: Email) {
  // BullMQ waits for initial Redis readiness. Fail fast here so a Redis outage
  // cannot hold the HTTP response open after the database has committed.
  if (redis.status !== "ready") throw new Error("Queue is not ready");
  await queue.add(
    "deliver",
    { emailId: email.id },
    {
      jobId: `email-${email.id}`,
      delay: Math.max(0, email.scheduled_at.getTime() - Date.now()),
      attempts: config.MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: config.RETRY_DELAY_MS },
      removeOnComplete: { age: 86400 },
      removeOnFail: false,
    },
  );
}
// MySQL rows are the durable outbox. Stable IDs make repeated enqueue safe.
// Scan in pages so an old pending row cannot starve newer schedules.
export async function reconcile() {
  if (redis.status !== "ready") throw new Error("Queue is not ready");
  let after = "";
  while (true) {
    const rows = await emails(
      "SELECT * FROM emails WHERE status IN ('scheduled','processing') AND id>? ORDER BY id LIMIT 200",
      [after],
    );
    if (!rows.length) break;
    for (const row of rows) {
      const job = await queue.getJob(`email-${row.id}`);
      if (!job) await enqueue(row);
      else if ((await job.getState()) === "failed")
        await db.query(
          "UPDATE emails SET status='failed',last_error=? WHERE id=? AND status IN ('scheduled','processing')",
          [
            "Delivery stopped after bounded retries or worker stalls; inspect worker logs.",
            row.id,
          ],
        );
    }
    after = rows.at(-1)!.id;
  }
}
export function startReconciler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await reconcile();
    } catch {
      console.error("Reconciliation unavailable; will retry.");
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), config.RECONCILE_INTERVAL_MS);
  return () => clearInterval(timer);
}
