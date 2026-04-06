# Etapa de build (por si querés reconstruir dentro del contenedor)
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Si ya tenés dist listo, esta línea no es obligatoria. Si querés construir en Docker, descomentalá:
RUN npm run build

# Etapa runtime: Nginx sirviendo estáticos
FROM nginx:alpine AS runtime
# Copiamos el build (carpeta dist) al docroot de Nginx
#COPY --from=builder /app/dist /usr/share/nginx/html

# SPA fallback: si tenés rutas de frontend (react-router/vite), agregá un nginx.conf
# que haga try_files ... =200 para index.html. Te lo dejo abajo.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx expone 80; lo mapeamos a 3052 desde docker-compose
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
