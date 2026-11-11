# Multi-stage production Dockerfile for MeGa X Local Core Daemon
# Stage 1: Build & compile TypeScript
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git

COPY daemon/package*.json ./daemon/
WORKDIR /app/daemon
RUN npm ci

COPY daemon/tsconfig.json ./
COPY daemon/src ./src
RUN npm run build

# Stage 2: Minimal production runner
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache git curl bash openssh-client ca-certificates

ENV NODE_ENV=production
ENV PORT=4040
ENV WORKSPACE_DIR=/workspace

RUN mkdir -p /workspace

COPY daemon/package*.json ./daemon/
WORKDIR /app/daemon
RUN npm ci --omit=dev

COPY --from=builder /app/daemon/dist ./dist

# Fallback default configuration
COPY megax.config.json /workspace/megax.config.json

EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4040/api/status || exit 1

WORKDIR /workspace

ENTRYPOINT ["node", "/app/daemon/dist/cli.js"]
CMD ["serve", "--port", "4040"]
