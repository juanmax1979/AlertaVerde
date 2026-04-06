# ========= Build base =========
FROM node:20-bookworm-slim AS base
ENV NODE_ENV=production \
    APP_HOME=/app
WORKDIR $APP_HOME

# Paquetes útiles para Baileys/QR/email (curl para healthcheck, tzdata para zona horaria, ffmpeg por si lo requiere)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl tzdata ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# ========= Deps =========
FROM base AS deps
COPY package*.json ./
# Si usás pnpm/yarn, cambiá este paso por pnpm i --prod o yarn --production
RUN npm ci --omit=dev

# ========= Release =========
FROM base AS release
USER node
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Carpeta para la sesión de Baileys/BuilderBot (persistida por volumen)
ENV SESSIONS_DIR=/app/.sessions
RUN mkdir -p $SESSIONS_DIR
VOLUME ["/app/.sessions"]

# Puerto HTTP que expone el provider de BuilderBot
ENV PORT=3008
EXPOSE 3008

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","app.js"]
