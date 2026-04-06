# ---------- Etapa de build ----------
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# Si compilas TypeScript u otros assets, hacelo aquí:
# RUN npm run build

# ---------- Etapa de runtime ----------
FROM node:20-slim AS runtime
WORKDIR /app

# curl para healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3500
ENV HOST=0.0.0.0
ENV UPLOAD_DIR=/app/uploads

# usuario no root
RUN useradd -u 10001 -m nodejs

# preparar carpetas y permisos
RUN mkdir -p /app/uploads && chown -R nodejs:nodejs /app

# Copiamos artefactos del build con ownership correcto
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
# Si tu app compila a /dist, cambia la línea anterior por:
# COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Dejar solo deps de producción
RUN npm prune --omit=dev

USER nodejs

# El contenedor escucha el puerto real de tu app
EXPOSE 3500

# Healthcheck: intenta /health y, si no, /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD curl -fsS http://localhost:3500/health || curl -fsS http://localhost:3500/api/health || exit 1

# Levante con tu script start (debe bindear HOST/PORT)
CMD ["npm", "start"]
