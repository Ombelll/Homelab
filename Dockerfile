# --- build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY prisma ./prisma
COPY tsconfig.json next.config.js tailwind.config.ts postcss.config.js ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app
RUN mkdir -p /data && chown -R app:app /data

COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/next.config.js ./

USER app
EXPOSE 3000

# Run migrations on boot so the SQLite file exists in the data volume.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start"]
