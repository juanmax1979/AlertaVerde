# ---------- Etapa de build ----------
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Instalamos dependencias del proyecto
# (si tenés package-lock.json, podés usar: npm ci)
RUN npm install

# Copiamos el código fuente
COPY . .

# 🔧 REBUILD de sharp dentro de @builderbot/provider-baileys
RUN cd node_modules/@builderbot/provider-baileys && \
    npm install sharp --force --include=optional --no-save && \
    npm rebuild sharp --verbose || true

# ---------- Etapa de runtime ----------
FROM node:20-slim AS runtime
WORKDIR /app

# Dependencias del sistema: ffmpeg, webp, tz, curl, certs y libvips para sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg webp tzdata curl ca-certificates libvips \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3501
ENV API_BASE_URL=http://backend:3500
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# usuario no root
RUN useradd -u 10002 -m nodebot && mkdir -p /app/bot_sessions && chown -R nodebot:nodebot /app

# Traemos node_modules y código desde el builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# 🔑 STUB de @ffmpeg-installer para que use /usr/bin/ffmpeg
RUN mkdir -p /app/node_modules/@ffmpeg-installer/ffmpeg \
    /app/node_modules/@ffmpeg-installer/linux-x64 && \
    printf "module.exports = { path: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg' };\n" \
      > /app/node_modules/@ffmpeg-installer/ffmpeg/index.js && \
    printf '{ "name": "@ffmpeg-installer/ffmpeg", "version": "0.0.0" }\n' \
      > /app/node_modules/@ffmpeg-installer/ffmpeg/package.json && \
    printf "module.exports = { path: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg' };\n" \
      > /app/node_modules/@ffmpeg-installer/linux-x64/index.js && \
    printf '{ "name": "@ffmpeg-installer/linux-x64", "version": "0.0.0" }\n' \
      > /app/node_modules/@ffmpeg-installer/linux-x64/package.json

USER nodebot
EXPOSE 3501

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD curl -fsS http://localhost:3501/health || exit 1

CMD ["npm", "start"]
