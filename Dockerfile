FROM oven/bun:latest AS builder
RUN apt-get update && apt-get install -y python3 python3-setuptools build-essential git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install
COPY . .
# Build sequentially: webpack (client) first, then tsc (server).
# run-p runs both in parallel, causing webpack to clobber dist/shared/types/
# that tsc emits, resulting in "Cannot find module '../shared/types/chan'" at runtime.
RUN NODE_ENV=production bun run build:client && bun run build:server

FROM node:24-alpine
ENV THELOUNGE_HOME="/var/opt/thelounge"
ENV NODE_ENV=production
EXPOSE 9000
RUN apk upgrade --no-cache && \
    apk --no-cache add sqlite
WORKDIR /app
COPY --from=builder /app /app
RUN install -d -o node -g node "${THELOUNGE_HOME}"
VOLUME "${THELOUNGE_HOME}"
USER node:node
ENTRYPOINT ["node", "/app/index.js"]
CMD ["start"]
