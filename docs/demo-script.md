# Tanish's recording script (target 4 minutes 30 seconds)

Record the browser and two PowerShell terminals. Keep `.env`, GitHub settings and credentials off screen. Close unrelated tabs and notifications. The public demo login is safe to show. Use a fresh recognizable subject for every take: **Tanish | Restart proof | Take 1**. Never schedule that subject twice in the same take.

## Before recording

Run these once from the project folder; Docker Desktop must be running:

```powershell
docker compose up -d --wait
npm.cmd run db:migrate
npm.cmd run build
# Only if Ethereal has not been configured or its account expired:
npm.cmd run ethereal:setup
```

Terminal A: `npm.cmd run start:api`. Terminal B: `npm.cmd run start:worker`. Terminal C: `npm.cmd run dev:web`. Open http://localhost:5173. Keep Docker services and Terminal C running throughout. For a hosted recording, use the verified public URL and the container restart commands in deployment.md instead.

## 0:00–0:30 — Introduce and log in

Say: “Hi, I'm Tanish Gupta. This is my Outbox Labs email scheduler. I used React and TypeScript, an Express API, MySQL, and a separate BullMQ worker backed by Redis.”

Click **Log in →** with the prefilled demo identity.

Say: “The dashboard reads persisted records. Scheduled, Sent and Failed are separate views, and every query is scoped to the logged-in user.”

## 0:30–1:15 — Schedule one recognizable email

Click **＋ Compose email**. Enter:

- Recipient: `interview@example.com`
- Subject: `Tanish | Restart proof | Take 1`
- Message: `This is the same email I scheduled before restarting the API and worker. — Tanish Gupta`
- Delivery time: about **90 seconds from now**, in the displayed local time zone.

If useful, calculate the exact local time in Terminal A **before starting its API process**, or another empty terminal:

```powershell
(Get-Date).AddSeconds(90).ToString('yyyy-MM-dd HH:mm:ss')
```

Say: “This time is in the displayed browser time zone. The API validates it, converts the timestamp to UTC, and saves it in MySQL before enqueueing.”

Click **Schedule email →**. Point to the recognizable subject and the short ID under Scheduled. Note the ID aloud. Refresh once; the row stays.

## 1:15–2:00 — Stop both processes before due time

In Terminal A press **Ctrl+C**. If PowerShell asks `Terminate batch job (Y/N)?`, type `Y`. Do the same in Terminal B. Leave MySQL, Redis and Vite running.

Say: “Both the HTTP API and worker are stopped. The browser cannot reach the API right now, but the schedule is still stored in MySQL and Redis's persistent volume.”

Restart in the same terminals:

```powershell
# Terminal A
npm.cmd run start:api
```

```powershell
# Terminal B
npm.cmd run start:worker
```

Say: “I have not scheduled another email. The worker reconnects to the same queue. A recovery loop also repairs jobs missing from Redis using the database record.”

Return to the dashboard, refresh and point to the same subject/ID. If the due time passes while both processes are stopped, that is also valid: explain that it becomes immediately eligible on restart.

## 2:00–2:45 — Show Sent and preview

Wait until the chosen time; allow a few seconds for SMTP and the two-second UI poll. Click the **Sent** tab. Find **Tanish | Restart proof | Take 1** and its original short ID. Point out the sent time and attempt count. Click **Open Ethereal preview ↗**.

Say: “This is the original email, with a recorded SMTP acceptance time and an actual Ethereal preview. Ethereal captures test email, so Sent means SMTP accepted it, not delivery to a real inbox.”

If it goes to Failed, do not claim success: stop the recording, inspect the worker and Ethereal configuration, fix the issue and make a new take with a new subject.

## 2:45–3:30 — Explain the reliability limits

Show the small README architecture diagram and `backend/src/worker.ts` if time permits.

Say: “The API and worker are independent processes. Jobs have stable IDs, so reconciliation can safely try to enqueue again. Retries are bounded, and concurrency and rate limiting are configurable.”

Say: “SMTP and MySQL cannot commit atomically. If the worker crashes after SMTP acceptance but before saving success, a retry can duplicate the email. This is at-least-once delivery, not exactly-once. The database attempt counter bounds retries.”

## 3:30–4:20 — Optional rate-limit demonstration

Only do this if you have time. With the default **2 starts per 10 seconds**, compose three short messages named `Rate demo 1`, `Rate demo 2`, and `Rate demo 3`, all due at the same time about 40 seconds ahead. Each must be saved before that due time. Show Scheduled, then Sent. Two can start in one limiter window; the third waits for another window. If there was earlier queue activity, the exact first window can differ.

Say: “The queue allows two delivery attempts per ten seconds across workers. Concurrency overlaps network requests, but it does not bypass that limit.”

Skip this section if it risks exceeding five minutes; automated test evidence in `docs/test-results.md` also covers a small batch.

## 4:20–4:35 — Close

Say: “The README has Windows setup commands, the architecture, test results and trade-offs. The repository includes isolated integration tests and a browser smoke test. Thank you.”

Upload the video yourself with reviewer-accessible viewing permissions. Check it in a signed-out browser. Send the real video and hosted URLs to update the existing LaTeX source/PDF. Review the final PDF before submitting the ClickUp form; no form is submitted by this project.
