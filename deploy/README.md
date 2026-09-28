# Production — sellerpro.org

This directory owns the shared stack (API, worker, web, PostgreSQL and Redis).
The existing host Nginx terminates TLS; only loopback ports 13000 and 14000 are published.
Backend and frontend are separate repositories. CI produces immutable `sellerpro-backend:<sha>`
and `sellerpro-frontend:<sha>` images. Deployments are serialized on the server with `flock`.

## Bootstrap (operator only)

1. Verify SSH host fingerprint and inspect existing services before using ports 80/443.
   Install Docker Engine + Compose plugin on the VPS. Point the domain A record at it;
   remove stale AAAA records. Allow 80/443 and the existing SSH port; do not expose databases.
2. Create `/opt/sellerpro/incoming` and `/opt/sellerpro/backups`. Copy `compose.yml`,
   `release.sh`, `ssh-entrypoint.sh` here. Review configuration changes before installing them;
   CI deliberately does not overwrite operator-owned infrastructure files.
3. Create `/opt/sellerpro/.env` from `.env.example`, mode 600. Generate independent random
   hex values (`openssl rand -hex 32`) for POSTGRES_PASSWORD and CREDENTIALS_KEY.
   Back up the encryption key separately; changing it loses access to encrypted store keys.
   Do not copy development credentials, shop.txt or test fixtures into production.
4. Download the `image-<sha>` artifact from each repository's successful CI run. Upload the
   tar.gz files to `incoming`, load both with `docker load -i <file>`. Create `.images.env`
   with BACKEND_IMAGE=sellerpro-backend:<backend-sha> and
   FRONTEND_IMAGE=sellerpro-frontend:<frontend-sha>, each on its own line.
5. From `/opt/sellerpro`, use
   `docker compose --env-file .env --env-file .images.env up -d --wait postgres redis`,
   then `docker compose --env-file .env --env-file .images.env run --rm migrate`,
   then `docker compose --env-file .env --env-file .images.env up -d --wait api worker web`.
   Install the dedicated `nginx-bootstrap.conf` site, obtain a certificate with Certbot
   using webroot `/var/www/sellerpro-acme`, then replace only that site's config with
   `nginx.conf`. Run `nginx -t` before reloading; preserve other sites. Enable certificate
   renewal and a deploy hook to reload Nginx.
   Check HTTPS, `/api/health`, login and worker logs before enabling continuous deployment.
6. Provision an admin with the password through stdin (not a command argument):
   `docker compose --env-file .env --env-file .images.env exec -T api ./node_modules/.bin/tsx scripts/provision-admin.ts <username>`.
   The CLI reads until EOF. Avoid shared terminal logs; use a protected password file/stdin.

## GitHub Actions configuration (both repos)

Secrets: `DEPLOY_SSH_KEY` (dedicated key, not your personal/root key), `DEPLOY_KNOWN_HOSTS`
(verified pinned host entry). Variables: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT` (22),
`DEPLOY_ENABLED` (`true` only after bootstrap). The dedicated CI key is authorized with
`restrict,command="/opt/sellerpro/ssh-entrypoint.sh"`, allowing only validated image upload
and release commands. It cannot open a shell, forward ports, or run arbitrary SSH commands.
Do not reuse your personal root key in GitHub. The release process has Docker access, which
is root-equivalent; restrict repository write access and require main branch reviews.
CD runs only for successful main builds; pull requests cannot access deployment secrets.
Alternatively, after the operator creates `.env` and `.images.env` with the intended first
commit tags, CI can bootstrap: the first arriving image is staged and the second starts
the full stack. A staged build alone does not mean the website is live. The `.initialized`
marker is written only after both public HTTPS probes succeed.

## Recovery / operations

Release takes a PostgreSQL custom-format backup before backend migrations and restores the
previous application images if a health check fails. It does **not** roll back database schema.
Keep migrations backward-compatible (expand/contract). Test database restore separately.
Backups here are local only: schedule encrypted off-server backups, including CREDENTIALS_KEY,
and retention appropriate to the business before storing important production data.
Do not use `docker compose down -v` or automated image/volume pruning.
Monitor disk usage of backups, images and incoming archives; the script never deletes them.
Worker process start is checked by Compose, not end-to-end marketplace task success.
Review `/admin` schedules after adding the first store; guards can write to marketplaces.

References: [Docker Next.js](https://docs.docker.com/guides/nextjs/),
[Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting),
[GitHub environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment).
