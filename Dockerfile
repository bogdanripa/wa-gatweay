# Pironman runs on a Raspberry Pi 5, so this image must be linux/arm64.
# Building on the Pi itself gets that for free. If you build on an x64 machine or
# in GitHub Actions, you must cross-build:
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

# Runs unprivileged. The node image already ships a `node` user.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Media is scratch space — TTL'd, re-downloadable, and deliberately not a volume.
RUN mkdir -p /tmp/wa-media && chown node:node /tmp/wa-media
USER node

EXPOSE 8080

# /health is 503 until the WhatsApp session is actually usable, so an orchestrator
# won't route traffic to a gateway that is sitting on an unscanned QR code.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
