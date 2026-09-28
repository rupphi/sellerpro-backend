# Sellerpro backend

NestJS API and independent BullMQ worker for Wildberries/Ozon stores.
Node.js 24 LTS, PostgreSQL 17, Redis 7.4, Prisma 6.

## Local development

Install with `npm ci`. Copy `.env.example` to `.env`, fill local database/Redis URLs
and a generated 32-byte hex CREDENTIALS_KEY. Run `npm run db:migrate`, then
`npm run dev` and `npm run worker:dev` in separate terminals.
Never commit store credentials, database backups or .env files.

## Structure

- `src/modules/`: auth, stores, pricing, automation, sales, finance, notifications and admin.
- `src/integrations/marketplaces/`: platform-specific API adapters and transport/rate limits.
- `src/infrastructure/`: PostgreSQL, Redis and queue clients.
- `src/worker.ts`: durable background processing; separate from the API process.
- `prisma/`: schema and versioned migrations.
- `test/`: unit and isolated integration tests; no live marketplace writes in CI.
- `deploy/`: production stack and release/rollback instructions.

`npm run build` generates Prisma and compiles TypeScript. `npm test` runs the unit suite
(database/Redis required). `npm run test:integration` starts a fixture-only API/worker;
use a dedicated test database, never a production URL. The separate normal-runtime test
requires a local API and explicit `RUN_LIVE_API_TEST=1`.

Production CI runs tests, builds a Linux container and saves an immutable image artifact.
CD is opt-in with DEPLOY_ENABLED after server bootstrap. See [deployment](deploy/README.md).
The frontend is maintained in [sellerpro-frontend](https://github.com/rupphi/sellerpro-frontend).
