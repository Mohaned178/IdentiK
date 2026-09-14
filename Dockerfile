FROM node:24.21.0-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY backend/prisma.config.ts ./backend/prisma.config.ts
COPY backend/prisma ./backend/prisma

RUN npm ci

COPY backend ./backend

RUN npm run build

FROM node:24.21.0-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY backend/prisma.config.ts ./backend/prisma.config.ts
COPY backend/prisma ./backend/prisma

RUN npm ci --omit=dev && rm -rf ./backend/src

COPY --from=build /app/backend/dist ./backend/dist
COPY docker-entrypoint.sh ./backend/docker-entrypoint.sh
RUN chmod 0755 ./backend/docker-entrypoint.sh

WORKDIR /app/backend

USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["server"]
