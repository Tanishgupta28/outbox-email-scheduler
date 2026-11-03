# Execution record — 3 November 2026

Tests ran on Tanish's Windows machine in PowerShell with Node 22.18.0, Docker Desktop 28.3.2, MySQL 8.4 and Redis 7.4. Records used unique `outbox_test_<timestamp>` databases and queue namespaces, removed after each run. The separate backend lab was not changed. Raw reports, screenshots and sanitized process logs are in ignored `test-results/`.

| Command / check | Observed result |
|---|---|
| `npm install` then patched Nodemailer to current version | Dependencies installed; lockfile committed |
| `npm run build` | Backend and frontend TypeScript passed; Vite built successfully |
| `npm audit --omit=dev` | Zero known production vulnerabilities at execution time |
| `docker compose up -d` / `docker compose ps` | MySQL and Redis running and healthy with named volumes |
| `npm run db:migrate` | Initial SQL applied; two demo users seeded |
| `npm run ethereal:setup` | Actual Ethereal account created; credentials stored only in ignored `.env` |
| `npm test -- --restart-services` | All 9 grouped checks passed using fake SMTP and real MySQL, Redis, API, workers and Chromium |
| Final `npm test` after the production frontend rebuild | All 8 grouped checks passed; five-message acceptance spread 5,014 ms |
| `npm run test:ethereal` | All 8 grouped checks passed using actual external Ethereal SMTP, including an opened preview |
| `docker build -t outbox-email-scheduler:local .` | Production multi-stage image built successfully |
| Tectonic compilation + `python scripts/verify_submission.py` + visual inspection | One page, 14,509 bytes; repository URI matches source; missing hosted/video links are plain text and Draft is visible |
| `docker compose -f compose.production.yaml config --quiet` with validation-only environment values | Production Compose configuration parses successfully |

## What the passing suites proved

- Valid login, session-required API access, rejection of invalid addresses, past times and dates without a time-zone offset.
- An accepted schedule immediately appeared in Scheduled; the other demo identity could not see it.
- Both **real API and worker OS processes** were force-killed before delivery, restarted against the same datastores, and the original ID reached Sent. The existing session remained valid.
- A second original email became due while both processes were offline, then sent after restart.
- The fake suite also restarted both MySQL and Redis containers, preserving the original schedule and delivering it afterward.
- The API committed a row while pointed at an unavailable Redis endpoint. It returned `queuePending=true`; restarting against healthy Redis caused reconciliation and delivery without another schedule request.
- A five-email batch ran with **two worker processes** sharing a limit of 2 starts per 2,500 ms. The fake run's first-to-last acceptance spread was **4,989 ms**; the real SMTP run's was **5,917 ms**. The suite allows the preceding fixed limiter window to expire before measuring a fresh batch.
- Fake SMTP rejection and actual Ethereal authentication rejection each stopped at **three persisted attempts** and exposed Failed with an honest error. The actual failure test used an intentionally wrong password only in that test worker's environment; it did not overwrite `.env`.
- Chromium: login → compose → Scheduled → reload → Sent → logout/login, with persistent records. The actual SMTP suite clicked the preview link and loaded the Ethereal page. Desktop and 390px mobile screenshots were captured; no page-level horizontal overflow or JavaScript page errors occurred. The small-screen table scrolls horizontally inside its own container.

## Issues found and fixed during testing

The first build needed `DOM.Iterable` in TypeScript's frontend libraries. The first dependency audit flagged the older Nodemailer range, which was upgraded. The first Redis-outage run revealed that BullMQ's initial readiness wait could hold an HTTP response after committing MySQL; the producer now checks Redis readiness and has a command timeout. An initial rate-limit assertion incorrectly included a preceding partially consumed window; the test now starts measurement after that window expires. The affected suites were rerun successfully.

An early GitHub Actions run for the pre-fix commit was cancelled after detecting the Redis-outage wait. The [subsequent GitHub Actions run](https://github.com/Tanishgupta28/outbox-email-scheduler/actions/runs/41678885011) passed on Linux: clean `npm ci`, build, MySQL/Redis integration suite and Chromium flow. Local passing evidence above is independent of CI.

## Limits of the evidence

No live hosting account suitable for this complete stack was connected, so public HTTPS login, hosted worker execution and hosted SMTP delivery remain **unverified**. The production image build is verified; it does not substitute for deployment verification. No video has been recorded or uploaded. The crash precisely between SMTP acceptance and MySQL success is documented as an ambiguous at-least-once window, not claimed as exactly-once or exhaustively fault-injected. Long-running load, host power-loss behavior, and production-scale pagination/monitoring have not been tested.

## Repository access

Repository: <https://github.com/Tanishgupta28/outbox-email-scheduler>, verified private.

| Requested reviewer | GitHub login returned | Status at invitation verification | Permission |
|---|---|---|---|
| `mitrajit` | `Mitrajit` | Invitation sent; pending acceptance | Write |
| `Yadav036` | `Yadav036` | Invitation sent; pending acceptance | Write |

Read-only invitations were attempted first and GitHub rejected each with HTTP 422 (`Cannot assign ... permission of read`). Write is the minimum collaborator permission this personal repository accepted. Pending invitations are not accepted access. GitHub's [personal-repository permission documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository) describes this limitation.

Both application forms remain unsubmitted. The submission PDF is intentionally a draft until the real hosted and video URLs are supplied.
