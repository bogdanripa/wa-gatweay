# Pironman runs on a Raspberry Pi 5, so this image must be linux/arm64. CI builds
# it that way (see .github/workflows/deploy.yml). If you ever build it by hand
# from an x64 machine you must cross-build:
#     docker buildx build --platform linux/arm64 -t <registry>/wa-gateway:latest --push .
#
# Debian slim rather than Alpine on purpose: `sharp` (a required Baileys peer
# dependency) ships prebuilt glibc binaries for arm64, and the musl path is a
# reliable way to lose an evening. The only other native-looking dependency,
# whatsapp-rust-bridge, is WebAssembly and architecture-independent.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# curl is not optional. Coolify's container healthcheck shells out to curl (then
# wget), and the slim image ships neither — without it the container never
# reports healthy and the deploy is rolled back with nothing obviously wrong.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Media is scratch space — TTL'd, re-downloadable, and deliberately not a volume.
RUN mkdir -p /tmp/wa-media

# Port 80 is privileged, so this runs as root. A `USER node` line here makes the
# process die at startup with EACCES, which reads like any other failure to boot.
ENV PORT=80
EXPOSE 80

# Liveness, not readiness. /api/health is 200 whenever the process is up — even
# with no numbers configured, which is exactly what a fresh deployment looks like
# before anyone has opened the console to add the first one. Gating the container
# on "every number is paired" would mean it could never go healthy long enough to
# pair any. /api/ready is the strict check, for a human or a monitor.
#
# This must name the same path as the app's configured health_path: the platform
# builds the container's real check from that, and this line is only the fallback
# for when that configuration didn't land. Two different paths means whichever
# check runs is testing a route nobody meant.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:80/api/health || exit 1

CMD ["node", "dist/server.js"]
