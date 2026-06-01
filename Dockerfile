# --- build stage ---
# Includes devDependencies (TypeScript, Prisma CLI, Next builder). We use
# the standalone output mode so the runtime stage only needs the resulting
# tree, not the full node_modules.
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma's engine needs OpenSSL + glibc-compat on Alpine.
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
COPY tsconfig.json next.config.js tailwind.config.ts postcss.config.js ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# --- runtime stage ---
# next/standalone packages only the minimum: the built app, a trimmed
# node_modules, and a tiny server.js. We add the Prisma engine binaries +
# the CLI for the db push boot step.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache libc6-compat openssl
RUN addgroup -S app && adduser -S app -G app
RUN mkdir -p /data && chown -R app:app /data

# Standalone bundle (server.js + minimal node_modules) and the static
# assets Next serves from .next/static.
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static

# Prisma needs the schema + the engine for the boot-time db push and so
# the generated client can locate its query engine at runtime.
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=app:app /app/node_modules/prisma ./node_modules/prisma

USER app
EXPOSE 3000

# Apply migrations on boot, then start the standalone server. db push is
# idempotent — new columns/tables across upgrades land automatically.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push --skip-generate && node server.js"]
