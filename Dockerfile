FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Keep the lockfile-installed Prisma/tsx tooling for migrations and the admin CLI.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY scripts/provision-admin.ts ./scripts/provision-admin.ts
COPY src/common/security.ts ./src/common/security.ts
COPY src/infrastructure/clients.ts ./src/infrastructure/clients.ts
COPY src/config/env.ts ./src/config/env.ts
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
