# Hosting the complete stack

## Upgrading for cancellation

Stop **all old API and worker instances** before enabling this feature. Old workers do not recognize `cancelled` and must not overlap with the new cancellation endpoint. On the deployment host, after obtaining the updated source:

```sh
docker compose -f compose.production.yaml stop api worker
docker compose -f compose.production.yaml build api worker migrate
docker compose -f compose.production.yaml run --rm migrate
docker compose -f compose.production.yaml up -d api worker
```

Migration `002_cancelled_status.sql` appends the terminal enum value and preserves existing emails, users and sessions. MySQL and Redis remain running with their volumes. If migration/build fails, leave API/worker stopped until resolved. For local Node processes, stop both, run `npm.cmd run db:migrate` and `npm.cmd run build`, then restart both. Once cancellation records exist, rollback must retain a worker that recognizes them.

Verify a future email's confirmation can be dismissed, then confirm cancellation, reload, restart the worker, and check that the email remains cancelled after its due time. The integration suite performs this flow against isolated local data, including transport-entry assertions with fake SMTP. It also tests cancellation racing with the real worker's database claim and Redis cleanup failure.

## Initial deployment notes (3 November 2026)

No suitable authenticated container hosting account was found during implementation. The connected Sites runtime uses Cloudflare Workers and does not support this persistent Node worker / raw TCP MySQL and Redis stack. No hosting purchase or public deployment has been made.

**Your next step:** sign in to a hosting provider and supply a Linux VM with Docker, persistent storage and outbound TCP 587, plus a DNS name you control. Use an existing free VM if available; check the provider's current pricing yourself before provisioning. A paid machine has not been authorized or created. Once a host/account is connected, this configuration can be deployed there.

## On that host

1. Point the chosen DNS name to the VM. Open inbound 80/443 and administrative SSH; do not open MySQL/Redis to the Internet. Install Docker Engine and Compose. Clone the private repository using your normal GitHub login, never a token embedded in a URL.
2. Copy `.env.example` to `.env`. Set the existing SMTP credentials locally (or run `npm ci` then `npm run ethereal:setup` with Node 22 installed). Add these production settings in an editor:

```dotenv
# Use your real DNS name; this is deliberately not a live URL.
PUBLIC_DOMAIN=YOUR_DNS_NAME
MYSQL_ROOT_PASSWORD=YOUR_RANDOM_ROOT_PASSWORD
MYSQL_PASSWORD=YOUR_RANDOM_DATABASE_PASSWORD
NODE_ENV=production
```

Use long random **alphanumeric** database passwords so URL encoding is unnecessary. Keep `.env` readable only by the deployment owner. Do not put it in source control. The production Compose file overrides the database, Redis and origin values to internal service addresses and your HTTPS domain. Keep the public demo password for the reviewer sandbox; do not put personal mail or private data into these public demo identities.

3. Build and start:

```powershell
docker compose -f compose.production.yaml up -d --build
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail 50 migrate api worker
```

The migration container runs once, then API and worker start. Caddy obtains HTTPS certificates for the configured DNS name. Only the proxy publishes network ports. All long-running services use `restart: unless-stopped`, so Docker restarts them after a crash or host reboot. The worker has a 60-second graceful-stop budget. Enable the Docker daemon at boot on Linux. Do not deploy the worker as a request-only serverless function or a service that sleeps when idle.

4. Verify `https://<your actual domain>/api/health`, log in at the real HTTPS root, schedule an email about 60 seconds ahead, and confirm Scheduled → Sent plus an Ethereal preview. Test the restart below while retaining MySQL and Redis:

```powershell
docker compose -f compose.production.yaml stop api worker
docker compose -f compose.production.yaml start api worker
docker compose -f compose.production.yaml logs --tail 30 worker
```

5. Back up MySQL, the Redis AOF volume and deployment configuration. Monitor worker logs, failed rows, oldest overdue schedules, disk space and `/api/health`. That endpoint checks the API's database/Redis connections; it does not prove the worker is alive, so perform a scheduled delivery check too. Secure cookies require HTTPS. If behind Caddy, the process-local API request limit is shared by the proxy address; this is conservative for this demo. A larger deployment should configure trusted proxies explicitly and use distributed authentication rate limiting.

If the host blocks SMTP, choose a host that allows Ethereal rather than disabling TLS or reporting fake delivery. A successful container build alone is not proof of hosted SMTP delivery. Add the public URL to the submission only after the hosted reviewer flow passes.
