# Email Scheduling Dashboard

**Tanish Gupta · Outbox Labs Software Development Engineer Intern assignment**

A React + TypeScript dashboard backed by Express, MySQL, Redis, BullMQ and Nodemailer. Schedule a test email, stop the API and worker, restart them, and watch the original record move from Scheduled to Sent without scheduling it again.

This is an Ethereal sandbox: **Sent means SMTP accepted the message**, not that a real recipient received it. Ethereal captures email for preview and does not deliver it to real inboxes.

## Windows quick start

Install Node.js 22 LTS, Git and Docker Desktop (Linux containers / WSL 2). Start Docker Desktop and wait until its engine is ready. Run every command from this repository. The separate `nodejs-backend-lab` repository is not involved.

```powershell
git clone https://github.com/Tanishgupta28/outbox-email-scheduler.git
cd outbox-email-scheduler
npm.cmd ci
Copy-Item .env.example .env
docker compose up -d --wait
npm.cmd run db:migrate
npm.cmd run ethereal:setup
npm.cmd run build
```

Only copy `.env.example` on a **clean checkout**. Replacing an existing `.env` would discard your generated Ethereal credentials. `npm.cmd` works even when PowerShell execution policy blocks `npm.ps1`. Docker uses local ports **3307** (MySQL) and **6380** (Redis) to avoid common local installations.

Open three PowerShell terminals in this folder:

```powershell
# Terminal 1: HTTP API
npm.cmd run start:api
```

```powershell
# Terminal 2: separate BullMQ worker
npm.cmd run start:worker
```

```powershell
# Terminal 3: React development server
npm.cmd run dev:web
```

Open **http://localhost:5173**. The API is on port 3001. Vite forwards `/api` requests to it, so the browser uses one origin. For source editing, use `dev:api` and `dev:worker` instead of the compiled start commands. Re-run `npm.cmd run build` before using `start:*` after edits.

### Reviewer login

The login form is prefilled with a public sandbox identity:

| Identity | Email | Public demo password |
|---|---|---|
| Tanish Gupta | `tanish@outbox.demo` | `OutboxDemo2026!` |
| Reviewer (separate inbox) | `reviewer@outbox.demo` | `OutboxDemo2026!` |

Click **Log in →**, then **＋ Compose email**. Enter one recipient, a subject, body, and a future local date/time. The composer and tables show your browser's IANA time zone, such as `Asia/Calcutta`. The browser converts local time to an ISO timestamp with UTC offset; MySQL stores UTC. Invalid recipients, empty content, missing time-zone offsets, past dates, and dates more than a year ahead are rejected by the API. Daylight-saving conversions follow the browser's local-time rules; choosing an arbitrary remote time zone is outside this demo's scope.

The password above is deliberately public, not a personal credential. Users sharing the same demo identity share that identity's inbox. Distinct identities are isolated by the server's session, never by a client-supplied user ID. Sessions survive process restarts, expire after 24 hours and are deleted at logout; opaque random tokens are stored hashed in MySQL. Cookies are HttpOnly, SameSite=Lax and Secure in production.

### Ethereal setup

`npm.cmd run ethereal:setup` calls Nodemailer's `createTestAccount()` and writes the resulting credentials to ignored `.env`. It never prints the password. Restart the worker after running it. Alternatively create an account at <https://ethereal.email> and set `SMTP_USER` / `SMTP_PASS` locally. Never commit `.env`, paste it into a recording, or include credentials in the PDF.

Ethereal requires outbound SMTP access (normally port 587 with STARTTLS). If a host blocks SMTP, delivery will fail after bounded retries; choose a host that permits it. This app intentionally restricts the SMTP host to Ethereal to keep the public sandbox from sending real mail.

## Architecture and code walkthrough

```mermaid
flowchart LR
  UI[React dashboard] -->|HTTP + session cookie| API[Express API]
  API -->|commit email + UTC time| DB[(MySQL)]
  API -->|stable job ID + delay| Q[(Redis / BullMQ)]
  R[Recovery loop in API and worker] -->|read nonterminal rows| DB
  R -->|repair missing jobs| Q
  Q --> W[Separate BullMQ worker]
  W -->|SMTP| E[Ethereal]
  W -->|sent time / preview / error| DB
  API -->|poll every 2 seconds| UI
```

1. `frontend/main.tsx` handles login, composing, date conversion and table refresh.
2. `backend/src/server.ts` checks the session, validates the request and commits an email row before touching Redis. The insert itself is an atomic MySQL write.
3. `backend/src/queue.ts` adds `email-<database UUID>` as the stable BullMQ job ID, with a delay until the stored due time. If Redis is unavailable, the API still returns the saved record with `queuePending=true`; the UI explains recovery is pending.
4. A worker takes a due job subject to the shared queue rate limit. `worker.ts` acquires a MySQL advisory lock for that email, checks terminal state and atomically claims the row while incrementing the persisted attempt counter before SMTP. Cancellation competes with this claim in MySQL.
5. `mail.ts` sends plain-text content through Nodemailer. On acceptance the worker saves `sent_at`, `preview_url` and `sent`. On error it records a retry or terminal failure. The UI's next poll moves the same ID into Sent or Failed.

Read these files in that order for an interview. `auth.ts` contains password hashing; `migrate.ts` applies versioned SQL and seeds the two demo identities. Migration DDL is idempotent because MySQL DDL implicitly commits; run one migration process per deployment.

## Restart persistence and the delivery guarantee

MySQL and Redis each have a named Docker volume. Redis uses AOF with `appendfsync always` and `noeviction`. API/worker process shutdown does not delete either datastore. `docker compose down` also preserves named volumes; **do not add `-v`** when demonstrating persistence.

The API and worker each run a non-overlapping recovery loop (default every 3 seconds). It scans nonterminal MySQL rows in pages, checks their stable job ID and adds a job if missing. Repeated adds are deduplicated by BullMQ. Thus database-success/enqueue-failure, missed future jobs, and jobs already due after downtime recover automatically. A failed BullMQ job is reflected as Failed in MySQL, including stalled-job exhaustion. Completed records are not recreated. Completed Redis jobs are retained for one day; failed jobs remain for diagnosis.

Delivery is **at-least-once with a bounded attempt budget**, not exactly-once. If the worker dies immediately after SMTP acceptance but before saving `sent`, the database cannot know whether the message was accepted. BullMQ recovers a stalled job and may send it again. A stable Message-ID is reused but SMTP does not guarantee deduplication. The database attempt counter prevents unlimited sends even after queue loss. The final failure can therefore mean “outcome unknown,” not necessarily “no email was accepted.” Advisory locks reduce concurrent duplicates while the MySQL connection is alive; they cannot make SMTP and MySQL atomic. The crash-after-acceptance window is explained, not claimed as eliminated or exhaustively fault-injected.

To strengthen this in a real product, use a delivery provider with an idempotency key and reconcile provider receipts. Exact delivery times are best effort: downtime, retry backoff and rate limits can make them later, never deliberately earlier.

## Cancelling an email and correcting a recipient

In Scheduled, **Cancel email** is available until the first delivery attempt. The confirmation includes the subject; dismissing it makes no request. Success shows **Email cancelled.** and removes the row from Scheduled. The record remains in MySQL with terminal status `cancelled`, so refreshing or restarting cannot restore it to Scheduled.

`POST /api/emails/:id/cancel` requires the existing session and origin checks. It returns 200 for a successful or repeated cancellation, 404 for a missing or another user's email, and 409 when delivery has already been claimed or finished. Cancellation and the worker claim use conditional updates on the same database row: only the winner can proceed. Retrying emails with prior attempts are too late to cancel because an earlier SMTP outcome may be unknown. Queue removal is best effort; the worker checks and atomically claims database state before entering the transport even when a cancelled job remains active in Redis.

Recovery scans only scheduled/processing rows. Enqueue rechecks the current row under a transaction lock before adding a missing job, preventing stale recovery snapshots from restoring cancelled jobs. Migration `002_cancelled_status.sql` appends the enum value without replacing records. **Upgrade API and worker together**, stopping old processes before enabling cancellation; see [deployment upgrade steps](docs/deployment.md#upgrading-for-cancellation).

Malformed recipients show **Please enter a valid email address.** in one accessible alert popup for six seconds. Button and Enter submissions use the same validation; another invalid submission restarts the timer. The draft stays open and focused on the recipient. The form uses `noValidate` to reach the React handler, then explicitly calls `reportValidity()` for the remaining native constraints; backend Zod validation still protects direct requests.

## Rate limits, concurrency and retries

| Variable | Default | Meaning |
|---|---:|---|
| `WORKER_CONCURRENCY` | 3 | Jobs processed concurrently per worker process |
| `RATE_LIMIT_MAX` | 2 | Maximum job starts per queue window, shared across workers |
| `RATE_LIMIT_DURATION_MS` | 10000 | Window duration; default is 2 attempts per 10 seconds |
| `MAX_ATTEMPTS` | 3 | Maximum SMTP attempts, enforced in MySQL and BullMQ |
| `RETRY_DELAY_MS` | 2000 | Exponential backoff base: about 2s then 4s |
| `RECONCILE_INTERVAL_MS` | 3000 | How often missing jobs are repaired |

Rate limits are global per queue, **not per user**, and retries also consume slots. Use the same settings across worker replicas. Higher concurrency overlaps I/O; it does not bypass the shared rate limit. BullMQ also permits only one stalled recovery before terminal failure. Changing `.env` requires restarting the relevant processes. Use a new queue for changed retry policies when existing jobs already carry previous settings.

Other settings: `DATABASE_URL` selects MySQL; `REDIS_URL` selects Redis; `QUEUE_NAME` namespaces jobs; `APP_ORIGIN` is the exact browser origin accepted for unsafe browser requests; `PORT` defaults to 3001. `NODE_ENV=production` enables Secure cookies, so production requires HTTPS. `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` configure Ethereal. `DEMO_PASSWORD` is used only when users are first seeded; migrations preserve existing users. `MAIL_TRANSPORT=fake` is rejected unless `NODE_ENV=test`.

## Features and trade-offs

| Feature | Backend | Frontend |
|---|---|---|
| Demo login and isolation | Scrypt passwords, persistent hashed sessions, user-scoped SELECT | Login, identity display, logout |
| Scheduling | Validated future UTC time, MySQL insert, stable BullMQ ID | Responsive compose dialog, local time zone, immediate Scheduled row |
| Cancellation | Owner-scoped atomic state change, worker claim guard, terminal recovery exclusion | Subject confirmation, success notice, row removed after confirmation from API |
| Durable recovery | AOF Redis, named volumes, MySQL reconciliation | Refresh/re-login reads authoritative status |
| Delivery | Separate worker, Ethereal SMTP, saved accepted time and preview | Scheduled, Sent and Failed tables, attempt count, preview link |
| Throughput | Configurable global limiter, concurrency and exponential retries | Batch schedules visibly spread over time |
| Failure handling | Bounded attempts, sanitized errors, stalled-job reconciliation | Honest error and queue-pending notices |

Shortcuts: public demo accounts rather than OAuth or registration; plain text only; one recipient per message; no attachments, editing, bulk CSV import or manual retry. Polling is used instead of WebSockets. The inbox list is unpaginated for this small assignment; recovery itself is paginated. API rate limiting is process-local abuse protection, whereas delivery rate limiting is shared in Redis. No universal retry button avoids accidentally re-sending an ambiguously accepted email. User content is rendered as text by React. Preview URLs are effectively bearer links and should be treated as private demo data.

## Tests

Start the Docker services, then:

```powershell
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd test
# Optional: also restart this project's MySQL/Redis containers (brief local outage):
npm.cmd test -- --restart-services
# Requires the generated Ethereal credentials; uses actual external SMTP:
npm.cmd run test:ethereal
```

Tests create a uniquely named `outbox_test_<timestamp>` MySQL database and queue; they never use the demo database's records. The local default admin URL is `mysql://root:outbox_root_local@127.0.0.1:3307/mysql`; set `TEST_ADMIN_DATABASE_URL` if your local setup differs. Each run removes only its own database and queue keys, never `FLUSHDB`. Do not run the two suites simultaneously because they share test port 3002.

The cancellation coverage checks authentication, cross-user denial, repeated requests, both orders of a real API/worker row-lock race, and a cancelled job retained during Redis cleanup failure. Chromium cancels through the UI, reloads, restarts API/worker, waits past due time, and checks that the fake mail transport was never entered. Ordinary uncancelled schedules still deliver after restart.

The recipient test uses Playwright's browser clock: the alert is visible at five seconds and gone by seven; resubmitting an invalid recipient resets the deadline, with checks at 5,999 and 6,000 milliseconds. The composer retains its draft. Before correcting only the recipient and submitting successfully, the test restores real browser time and checks the unchanged delivery time against both the browser clock and the API's real HTTP Date. This avoids confusing virtual popup time with the backend's actual scheduling clock.

`tests/integration.ts` starts compiled API/worker processes, force-kills and restarts both before due time and after a due time passes, verifies SQL-success/enqueue-failure recovery, validation, sessions, isolation, a five-message rate-limited batch and bounded failures. Playwright runs login → compose → Scheduled → reload → Sent → logout/login and checks mobile overflow. Default tests replace **only SMTP** with a fake transport. `test:ethereal` uses real SMTP, verifies a real preview URL, opens the preview in Chromium, and deliberately supplies invalid SMTP credentials for its failure test. Reports and screenshots are generated under ignored `test-results/`. See [docs/test-results.md](docs/test-results.md) for the actual execution record and limits.

## Deployment

The complete stack is configured in `Dockerfile`, `compose.production.yaml` and `deploy/Caddyfile`. A single Linux host with Docker, persistent disk, a DNS name and outbound SMTP can run it. The API serves the built React files; the worker remains a separate container. See [docs/deployment.md](docs/deployment.md) for exact setup and verification. A static frontend alone does not satisfy this assignment. No hosted URL is claimed until the full stack and hosted worker pass the reviewer flow.

## Demo and submission

- [Under-five-minute recording script](docs/demo-script.md)
- [LaTeX submission source](submission/Tanish_Gupta_Outbox_Assignment.tex)
- [Compiled submission PDF](submission/Tanish_Gupta_Outbox_Assignment.pdf)
- [Official guidelines](https://drive.google.com/file/d/1AzTQSLCyTuMx31tx522xGcmBKcFLpYM9/view)
- [User-provided ClickUp form](https://forms.clickup.com/9005062261/f/8cbwp3n-8876/6NNNJ92DV93PQTAYST)

The guidelines' PDF also points to a Google form; the user-provided ClickUp form is the submission reference for this project. Neither form is submitted automatically. The PDF stays visibly Draft while the hosted or video URL is missing. Put real URLs into `\HostedURL`, `\VideoURL` and `\RepositoryURL` near the top of the source; leave missing URLs empty. Draft marking is automatic.

Compile with an installed Tectonic executable:

```powershell
tectonic --outdir submission submission/Tanish_Gupta_Outbox_Assignment.tex
```

Or upload the `.tex` file to Overleaf and click **Recompile** (pdfLaTeX). With MiKTeX locally: `pdflatex -interaction=nonstopmode -halt-on-error -output-directory=submission submission/Tanish_Gupta_Outbox_Assignment.tex`. Inspect the PDF and test all three links before submission.

On the prepared Windows machine, run `.\.tools\tectonic\tectonic.exe --outdir submission submission/Tanish_Gupta_Outbox_Assignment.tex` from this folder. That downloaded compiler is ignored by Git. To check page count, file size, draft marking, and PDF URI annotations against the three source commands:

```powershell
python -m pip install pypdf pymupdf
python scripts/verify_submission.py
```

The verifier also renders `tmp/pdfs/submission.png` for visual inspection. Once all three real links are present, the LaTeX automatically removes the draft label. Recompile, verify, then commit and push the same two submission files.

Implementation references: [BullMQ rate limiting](https://docs.bullmq.io/guide/rate-limiting), [retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [stalled jobs](https://docs.bullmq.io/guide/jobs/stalled), [Nodemailer Ethereal setup](https://nodemailer.com/guides/testing-with-ethereal), [Docker Compose production](https://docs.docker.com/compose/how-tos/production/).
