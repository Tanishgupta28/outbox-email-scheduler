// Runs real MySQL, Redis, API and worker processes. Only SMTP is faked by default.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { chromium } from "@playwright/test";
const real = process.argv.includes("--ethereal");
const dbName = `outbox_test_${Date.now()}`;
const adminUrl =
  process.env.TEST_ADMIN_DATABASE_URL ||
  "mysql://root:outbox_root_local@127.0.0.1:3307/mysql";
const admin = await mysql.createConnection(adminUrl);
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
  const migration = start("migrate");
  const [exit] = await once(migration, "exit");
  children.delete(migration);
  assert.equal(exit, 0);
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
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByRole("button", { name: "Log in →" }).click();
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
  // Delete only this run's queue keys. Never FLUSHDB shared Redis.
  const { Redis } = await import("ioredis");
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
