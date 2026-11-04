// Runs real MySQL, Redis, API and worker processes. Only SMTP is faked by default.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { chromium, expect } from "@playwright/test";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
const real = process.argv.includes("--ethereal");
const dbName = `outbox_test_${Date.now()}`;
const adminUrl =
  process.env.TEST_ADMIN_DATABASE_URL ||
  "mysql://root:outbox_root_local@127.0.0.1:3307/mysql";
let admin = await mysql.createConnection(adminUrl);
await admin.query(`CREATE DATABASE \`${dbName}\``);
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${dbName}`;
const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT: "3002",
  APP_ORIGIN: "http://127.0.0.1:3002",
  DATABASE_URL: databaseUrl.toString(),
  QUEUE_NAME: dbName,
  MAIL_TRANSPORT: real ? "ethereal" : "fake",
  MAX_ATTEMPTS: "3",
  RETRY_DELAY_MS: "200",
  RECONCILE_INTERVAL_MS: "300",
  RATE_LIMIT_MAX: "2",
  RATE_LIMIT_DURATION_MS: "2500",
};
const children = new Set<ChildProcess>();
const logs: string[] = [];
const results: string[] = [];
const base = "http://127.0.0.1:3002";
const testRedis = new Redis(env.REDIS_URL!);
const testQueue = new Queue(dbName, { connection: testRedis });
function start(file: string, override: Record<string, string> = {}) {
  const child = spawn(process.execPath, [`dist/backend/${file}.js`], {
    env: { ...env, ...override },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && !child.killed) {
    const done = once(child, "exit");
    child.kill("SIGKILL");
    await done;
  }
  children.delete(child);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, timeout = 40000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await sleep(200);
  }
  throw new Error("Timed out waiting for expected state");
}
async function ready() {
  await until(async () => {
    const r = await fetch(`${base}/api/me`);
    return r.status === 401;
  });
}
async function login(email = "tanish@outbox.demo") {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: env.DEMO_PASSWORD || "OutboxDemo2026!",
    }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0];
}
async function request(path: string, cookie: string, body?: unknown) {
  return fetch(`${base}/api${path}`, {
    signal: AbortSignal.timeout(15000),
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function list(cookie: string) {
  return (await request("/emails", cookie)).json() as Promise<any[]>;
}
async function schedule(
  cookie: string,
  subject: string,
  delay = 1500,
  recipient = "test@example.com",
) {
  const res = await request("/emails", cookie, {
    recipient,
    subject,
    body: "Restart-safe interview demonstration by Tanish Gupta.",
    scheduledAt: new Date(Date.now() + delay).toISOString(),
  });
  assert.equal(res.status, 201);
  return res.json();
}
async function sent(cookie: string, id: string) {
  return until(
    async () => {
      const row = (await list(cookie)).find((r) => r.id === id);
      if (row?.status === "failed") throw new Error("Delivery failed");
      return row?.status === "sent" ? row : false;
    },
    real ? 90000 : 40000,
  );
}
function pass(message: string) {
  results.push(message);
  console.log(`PASS ${message}`);
}
try {
  // Upgrade an existing v1 database, not just an empty schema.
  await admin.query(`USE \`${dbName}\``);
  const initial = await readFile("backend/migrations/001_initial.sql", "utf8");
  for (const statement of initial.split(";").filter((s) => s.trim()))
    await admin.query(statement);
  await admin.query(
    "INSERT INTO users VALUES('legacy','legacy@example.com','Legacy','preserved-hash')",
  );
  await admin.query(
    "INSERT INTO emails(id,user_id,recipient,subject,body,scheduled_at,status,attempts,sent_at) VALUES('legacy-email','legacy','old@example.com','Preserved subject','Preserved body',UTC_TIMESTAMP(3),'sent',1,UTC_TIMESTAMP(3))",
  );
  const [legacyBefore] = await admin.query(
    "SELECT * FROM emails WHERE id='legacy-email'",
  );
  const migration = start("migrate");
  const [exit] = await once(migration, "exit");
  children.delete(migration);
  assert.equal(exit, 0);
  const repeatedMigration = start("migrate");
  assert.equal((await once(repeatedMigration, "exit"))[0], 0);
  children.delete(repeatedMigration);
  const [legacyAfter] = await admin.query(
    "SELECT * FROM emails WHERE id='legacy-email'",
  );
  assert.deepEqual(legacyAfter, legacyBefore);
  pass(
    "Migration upgrades existing schema and preserves records; rerun is safe",
  );
  let api = start("server"),
    worker = start("worker");
  await ready();
  assert.equal((await fetch(`${base}/api/emails`)).status, 401);
  const cookie = await login(),
    other = await login("reviewer@outbox.demo");
  const bad = await request("/emails", cookie, {
    recipient: "invalid",
    subject: "Bad",
    body: "body",
    scheduledAt: new Date(Date.now() + 5000).toISOString(),
  });
  assert.equal(bad.status, 400);
  const past = await request("/emails", cookie, {
    recipient: "a@example.com",
    subject: "Past",
    body: "body",
    scheduledAt: new Date(Date.now() - 5000).toISOString(),
  });
  assert.equal(past.status, 400);
  const noZone = await request("/emails", cookie, {
    recipient: "a@example.com",
    subject: "No zone",
    body: "body",
    scheduledAt: "2027-01-01T12:30:00",
  });
  assert.equal(noZone.status, 400);
  pass(
    "Login, authentication, invalid address, past date and missing timezone validation",
  );
  const future = await schedule(
    cookie,
    "Recognizable restart email — Tanish",
    9000,
  );
  assert.equal(
    (await list(cookie)).find((r) => r.id === future.id).status,
    "scheduled",
  );
  assert.equal((await list(other)).length, 0);
  pass("Immediate Scheduled visibility and user isolation");
  await stop(api);
  await stop(worker);
  await sleep(1200);
  api = start("server");
  worker = start("worker");
  await ready();
  assert.ok((await list(cookie)).some((r) => r.id === future.id));
  const delivered = await sent(cookie, future.id);
  assert.ok(delivered.sent_at);
  if (real) assert.match(delivered.preview_url, /^https:\/\/ethereal.email\//);
  pass(
    "Both API and worker killed before due time; original email sent after restart with persistent login",
  );
  const overdue = await schedule(cookie, "Due while offline", 1800);
  await stop(api);
  await stop(worker);
  await sleep(2500);
  api = start("server");
  worker = start("worker");
  await ready();
  await sent(cookie, overdue.id);
  pass(
    "Email becoming due while both processes offline recovered automatically",
  );
  if (process.argv.includes("--restart-services")) {
    const durable = await schedule(
      cookie,
      "Survives database and Redis restart",
      3000,
    );
    await stop(api);
    await stop(worker);
    await admin.end();
    await promisify(execFile)("docker", [
      "compose",
      "restart",
      "mysql",
      "redis",
    ]);
    await until(async () => {
      const candidate = await mysql.createConnection(adminUrl);
      await candidate.query("SELECT 1");
      admin = candidate;
      return true;
    }, 60000);
    api = start("server");
    worker = start("worker");
    await ready();
    await sent(cookie, durable.id);
    pass(
      "MySQL and Redis container restart retained schedule and delivered original email",
    );
  }
  await stop(api);
  await stop(worker);
  api = start("server", { REDIS_URL: "redis://127.0.0.1:6399" });
  await ready();
  const repair = await schedule(
    cookie,
    "Committed while Redis unavailable",
    1000,
  );
  assert.equal(repair.queuePending, true);
  await stop(api);
  api = start("server");
  worker = start("worker");
  await ready();
  await sent(cookie, repair.id);
  pass("MySQL commit with failed enqueue recovered by reconciliation");
  // Let the previous message's fixed limiter window expire. Otherwise a batch
  // can legitimately straddle its boundary and have a shorter acceptance span.
  await sleep(2700);
  const secondWorker = start("worker");
  const batch = [];
  for (let i = 0; i < 5; i++)
    batch.push(await schedule(cookie, `Rate batch ${i + 1}`, 2000));
  const batchSent = await Promise.all(batch.map((row) => sent(cookie, row.id)));
  const times = batchSent
    .map((r) => new Date(r.sent_at).getTime())
    .sort((a, b) => a - b);
  assert.ok(
    times[4] - times[0] >= 4400,
    `Batch spread ${times[4] - times[0]}ms`,
  );
  pass(
    `Rate limit across 5 emails: ${times[4] - times[0]} ms spread (2 starts / 2500 ms)`,
  );
  await stop(secondWorker);
  if (real) {
    await stop(worker);
    worker = start("worker", {
      SMTP_PASS: "deliberately-invalid-for-failure-test",
    });
  }
  const failed = await schedule(
    cookie,
    "Intentional failure",
    1000,
    "fail@example.com",
  );
  const terminal = await until(async () => {
    const r = (await list(cookie)).find((r) => r.id === failed.id);
    return r?.status === "failed" ? r : false;
  }, 90000);
  assert.equal(terminal.attempts, 3);
  assert.ok(terminal.last_error);
  pass(
    real
      ? "Real SMTP authentication rejection: bounded 3 attempts and Failed status"
      : "Fake SMTP rejection: bounded 3 attempts and Failed status",
  );
  if (real) {
    await stop(worker);
    worker = start("worker");
  }
  await stop(worker);
  const cancellable = await schedule(cookie, "Owner-only cancellation", 60000);
  const cancelPath = `/emails/${cancellable.id}/cancel`;
  assert.equal((await request(cancelPath, "", {})).status, 401);
  assert.equal((await request(cancelPath, other, {})).status, 404);
  assert.equal(
    (await request("/emails/missing/cancel", cookie, {})).status,
    404,
  );
  assert.equal(
    (await list(cookie)).find((r) => r.id === cancellable.id).status,
    "scheduled",
  );
  const cancellations = await Promise.all([
    request(cancelPath, cookie, {}),
    request(cancelPath, cookie, {}),
  ]);
  assert.deepEqual(
    cancellations.map((r) => r.status),
    [200, 200],
  );
  assert.equal((await request(cancelPath, cookie, {})).status, 200);
  assert.equal((await request(cancelPath, other, {})).status, 404);
  assert.equal(await testQueue.getJob(`email-${cancellable.id}`), undefined);
  assert.equal(
    (await request(`/emails/${future.id}/cancel`, cookie, {})).status,
    409,
  );
  assert.equal(
    (await request(`/emails/${failed.id}/cancel`, cookie, {})).status,
    409,
  );
  pass(
    "Cancellation requires authentication and ownership; concurrent/repeated requests are idempotent; sent/failed records return 409; queued job removed",
  );

  // Force both real database race orderings. A third connection holds the row
  // while API/worker queue their competing UPDATEs; inspect actual lock waits
  // rather than guessing timing. The worker reads the pre-cancel snapshot.
  async function waitingFor(id: string, fragment: string) {
    await until(async () => {
      const [transactions]: any = await admin.query(
        "SELECT trx_query FROM information_schema.innodb_trx WHERE trx_state='LOCK WAIT'",
      );
      return transactions.some(
        (t: any) => t.trx_query?.includes(id) && t.trx_query.includes(fragment),
      );
    }, 10000);
  }
  for (const winner of ["cancel", "worker"]) {
    const racing = await schedule(cookie, `Race won by ${winner}`, 500);
    const blocker = await mysql.createConnection(databaseUrl.toString());
    let cancellation: Promise<Response>;
    try {
      await blocker.beginTransaction();
      await blocker.query("SELECT * FROM emails WHERE id=? FOR UPDATE", [
        racing.id,
      ]);
      if (winner === "cancel") {
        cancellation = request(`/emails/${racing.id}/cancel`, cookie, {});
        await waitingFor(racing.id, "status='cancelled'");
        worker = start("worker");
        await waitingFor(racing.id, "attempts=attempts+1");
      } else {
        worker = start("worker");
        await waitingFor(racing.id, "attempts=attempts+1");
        cancellation = request(`/emails/${racing.id}/cancel`, cookie, {});
        await waitingFor(racing.id, "status='cancelled'");
      }
      assert.equal(
        await (await testQueue.getJob(`email-${racing.id}`))!.getState(),
        "active",
      );
      await blocker.commit();
      const response = await cancellation;
      assert.equal(response.status, winner === "cancel" ? 200 : 409);
      if (winner === "cancel") {
        await until(async () => {
          const job = await testQueue.getJob(`email-${racing.id}`);
          return !job || (await job.getState()) === "completed";
        });
        const row = (await list(cookie)).find((r) => r.id === racing.id);
        assert.equal(row.status, "cancelled");
        assert.equal(row.attempts, 0);
        assert.ok(
          !logs.join("").includes(`transport invoked email ${racing.id}`),
        );
      } else {
        assert.match((await response.json()).error, /too late to cancel/);
        await sent(cookie, racing.id);
      }
    } finally {
      await blocker.rollback();
      await blocker.end();
      await stop(worker);
    }
  }
  pass(
    "Real API/worker row-lock races: cancellation wins after worker reads stale state; worker claim wins with 409 and delivery",
  );

  const cleanupFailure = await schedule(
    cookie,
    "Cancel despite Redis outage",
    2500,
  );
  await stop(api);
  api = start("server", { REDIS_URL: "redis://127.0.0.1:6399" });
  await ready();
  assert.equal(
    (await request(`/emails/${cleanupFailure.id}/cancel`, cookie, {})).status,
    200,
  );
  assert.ok(await testQueue.getJob(`email-${cleanupFailure.id}`));
  await stop(api);
  api = start("server");
  worker = start("worker");
  await ready();
  await until(
    async () =>
      (await (await testQueue.getJob(
        `email-${cleanupFailure.id}`,
      ))!.getState()) === "completed",
  );
  const cancelled = (await list(cookie)).find(
    (r) => r.id === cleanupFailure.id,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.attempts, 0);
  assert.equal(cancelled.sent_at, null);
  assert.ok(!logs.join("").includes(`transport invoked email ${cancelled.id}`));
  await (await testQueue.getJob(`email-${cancelled.id}`))!.remove();
  await sleep(1000);
  assert.equal(await testQueue.getJob(`email-${cancelled.id}`), undefined);
  pass(
    "Redis cleanup failure leaves a job that worker safely skips after API/worker restart; recovery never recreates cancelled job",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Install before app code creates timers. Pause after loading so popup
    // deadlines can be asserted without relying on wall-clock sleeps.
    await page.clock.install({ time: Date.now() - 60000 });
    await page.goto(base);
    await page.getByRole("button", { name: "Log in →" }).click();
    await page.getByRole("button", { name: "＋ Compose email" }).click();
    const recipient = page.getByLabel("Recipient", { exact: true });
    const subject = page.getByLabel("Subject", { exact: true });
    const message = page.getByLabel("Message", { exact: true });
    const delivery = page.getByLabel("Delivery date and time");
    const submit = page.getByRole("button", { name: "Schedule email →" });
    const localTime = (delay: number) => {
      const date = new Date(Date.now() + delay);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19);
    };
    let scheduleRequests = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/emails")
        scheduleRequests++;
    });
    await recipient.fill("browser@example.com");
    await message.fill("All my typed content must survive validation.");
    // Check native required fields before the popup flow so correcting the
    // recipient later is the only change made to the retained draft.
    await delivery.fill(localTime(45000));
    await submit.click();
    await expect(subject).toBeFocused();
    await subject.fill("Browser cancellation — preserve draft");
    await message.fill("");
    await submit.click();
    await expect(message).toBeFocused();
    await message.fill("All my typed content must survive validation.");
    await delivery.fill("");
    await submit.click();
    await expect(delivery).toBeFocused();
    assert.equal(scheduleRequests, 0);
    const draftDate = localTime(45000);
    await delivery.fill(draftDate);
    await recipient.fill("abc");
    await page.clock.pauseAt(Date.now());
    await submit.click();
    const popup = page
      .getByRole("alert")
      .filter({ hasText: "Please enter a valid email address." });
    await expect(popup).toBeVisible();
    await expect(recipient).toBeFocused();
    await page.screenshot({
      path: "test-results/invalid-recipient-popup.png",
      fullPage: true,
    });
    await page.clock.runFor(5000);
    await expect(popup).toBeVisible();
    await page.clock.runFor(2000);
    await expect(popup).toBeHidden();
    // Enter uses the same handler. A repeated invalid submission must reset
    // the single alert's deadline, even after five seconds have elapsed.
    await recipient.fill("name@");
    await recipient.press("Enter");
    await expect(popup).toBeVisible();
    await page.clock.runFor(5000);
    await expect(popup).toBeVisible();
    await recipient.press("Enter");
    await expect(popup).toHaveCount(1);
    await expect(recipient).toBeFocused();
    await page.clock.runFor(5000);
    await expect(popup).toBeVisible();
    await page.clock.runFor(999);
    await expect(popup).toBeVisible();
    await page.clock.runFor(1);
    await expect(popup).toBeHidden();
    await page.clock.runFor(1000);
    await expect(popup).toBeHidden();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(recipient).toHaveValue("name@");
    await expect(subject).toHaveValue("Browser cancellation — preserve draft");
    await expect(message).toHaveValue(
      "All my typed content must survive validation.",
    );
    await expect(delivery).toHaveValue(draftDate);
    assert.equal(scheduleRequests, 0);
    // Rejoin server time for real scheduling and the later worker checks.
    await page.clock.setSystemTime(Date.now());
    await page.clock.resume();
    await recipient.fill("browser@example.com");
    await expect(delivery).toHaveValue(draftDate);
    const browserTiming = await delivery.evaluate(
      (input: HTMLInputElement) => ({
        scheduledAt: new Date(input.value).getTime(),
        now: Date.now(),
      }),
    );
    // The API's HTTP Date header uses its real Node clock, unaffected by
    // page.clock. The test runner shares that clock and checks milliseconds.
    const serverResponse = await request("/me", cookie);
    const serverNow = Date.parse(serverResponse.headers.get("date")!);
    assert.ok(Number.isFinite(serverNow), "API must expose its real HTTP Date");
    assert.ok(
      browserTiming.scheduledAt > browserTiming.now + 5000,
      "Retained delivery time must be future according to the browser clock",
    );
    assert.ok(
      browserTiming.scheduledAt > serverNow + 5000 &&
        browserTiming.scheduledAt > Date.now() + 5000,
      "Retained delivery time must be future according to the real backend clock",
    );
    const scheduledResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/emails",
    );
    await submit.click();
    const response = await scheduledResponse;
    assert.equal(response.status(), 201);
    const scheduledEmail = await response.json();
    assert.equal(
      new Date(scheduledEmail.scheduled_at).getTime(),
      browserTiming.scheduledAt,
    );
    assert.equal(scheduledEmail.recipient, "browser@example.com");
    assert.equal(
      scheduledEmail.subject,
      "Browser cancellation — preserve draft",
    );
    assert.equal(
      scheduledEmail.body,
      "All my typed content must survive validation.",
    );
    assert.equal(scheduleRequests, 1);
    await expect(page.getByRole("dialog")).toBeHidden();
    const cancelRow = page
      .getByRole("row")
      .filter({ hasText: "Browser cancellation — preserve draft" });
    await expect(cancelRow).toBeVisible();
    const uiEmail = (await list(cookie)).find(
      (r) => r.subject === "Browser cancellation — preserve draft",
    );
    assert.equal(uiEmail.id, scheduledEmail.id);
    assert.equal(uiEmail.status, "scheduled");
    pass(
      "Chromium with controlled clock: invalid popup visible at 5s, gone by 7s; Enter restarts one alert until exactly 6s; retained draft time is future for browser and backend; correcting only recipient schedules with HTTP 201 and Scheduled row; required validation preserved",
    );
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.type(), "confirm");
      assert.ok(dialog.message().includes(uiEmail.subject));
      await dialog.dismiss();
    });
    await cancelRow
      .getByRole("button", { name: "Cancel email", exact: true })
      .click();
    await expect(cancelRow).toBeVisible();
    assert.equal(
      (await list(cookie)).find((r) => r.id === uiEmail.id).status,
      "scheduled",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await cancelRow
      .getByRole("button", { name: "Cancel email", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Email cancelled.");
    await expect(cancelRow).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "＋ Compose email" }),
    ).toBeVisible();
    await expect(cancelRow).toHaveCount(0);
    await stop(api);
    await stop(worker);
    api = start("server");
    worker = start("worker");
    await ready();
    await sleep(
      Math.max(0, new Date(uiEmail.scheduled_at).getTime() - Date.now()) + 1500,
    );
    const uiCancelled = (await list(cookie)).find((r) => r.id === uiEmail.id);
    assert.equal(uiCancelled.status, "cancelled");
    assert.equal(uiCancelled.attempts, 0);
    assert.equal(uiCancelled.sent_at, null);
    assert.equal(await testQueue.getJob(`email-${uiEmail.id}`), undefined);
    assert.ok(!logs.join("").includes(`transport invoked email ${uiEmail.id}`));
    await page.reload();
    await expect(
      page.getByRole("button", { name: "＋ Compose email" }),
    ).toBeVisible();
    await expect(cancelRow).toHaveCount(0);
    pass(
      "Chromium: confirmation names subject; dismiss leaves email unchanged; confirmed cancellation survives refresh and API/worker restart past due time without transport invocation",
    );

    await page.getByRole("button", { name: "＋ Compose email" }).click();
    await page
      .getByLabel("Recipient", { exact: true })
      .fill("browser@example.com");
    await page
      .getByLabel("Subject", { exact: true })
      .fill("Browser smoke — Tanish");
    await page
      .getByLabel("Message", { exact: true })
      .fill("The full reviewer flow works.");
    const target = new Date(Date.now() + 5000);
    const local = new Date(
      target.getTime() - target.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 19);
    await page.getByLabel("Delivery date and time").fill(local);
    await page.getByRole("button", { name: "Schedule email →" }).click();
    await page
      .getByRole("row")
      .filter({ hasText: "Browser smoke — Tanish" })
      .waitFor();
    await page.reload();
    await page
      .getByRole("row")
      .filter({ hasText: "Browser smoke — Tanish" })
      .waitFor();
    await page
      .getByRole("navigation", { name: "Email status" })
      .getByRole("button", { name: /Sent/ })
      .click();
    const row = page
      .getByRole("row")
      .filter({ hasText: "Browser smoke — Tanish" });
    await row.waitFor({ timeout: 90000 });
    if (real) {
      const link = row.getByRole("link", { name: "Open Ethereal preview ↗" });
      assert.match(
        (await link.getAttribute("href"))!,
        /^https:\/\/ethereal.email\//,
      );
      const [preview] = await Promise.all([
        page.waitForEvent("popup"),
        link.click(),
      ]);
      await preview.waitForLoadState();
      assert.ok((await preview.locator("body").innerText()).length > 100);
      await preview.close();
    }
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: `test-results/${real ? "ethereal" : "fake"}-dashboard.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `test-results/${real ? "ethereal" : "fake"}-mobile.png`,
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.getByRole("button", { name: "Log out" }).click();
    await page.getByRole("button", { name: "Log in →" }).click();
    await page
      .getByRole("navigation", { name: "Email status" })
      .getByRole("button", { name: /Sent/ })
      .click();
    await row.waitFor();
    assert.deepEqual(errors, []);
    pass(
      "Chromium: login → compose → Scheduled → refresh → Sent → logout/login; mobile width and no browser errors" +
        (real ? "; Ethereal preview opened" : ""),
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  await testQueue.close();
  await testRedis.quit();
  // Delete only this run's queue keys. Never FLUSHDB shared Redis.
  const redis = new Redis(env.REDIS_URL!);
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `bull:${dbName}:*`,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
  await redis.quit();
  await admin.query(`DROP DATABASE \`${dbName}\``);
  await admin.end();
  await mkdir("test-results", { recursive: true });
  await writeFile(
    `test-results/${real ? "ethereal" : "fake"}-report.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        transport: real ? "actual Ethereal SMTP" : "fake SMTP",
        passed: results,
        success: !process.exitCode,
      },
      null,
      2,
    ),
  );
  await writeFile(
    `test-results/${real ? "ethereal" : "fake"}-process.log`,
    logs.join(""),
  );
}
