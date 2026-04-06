# Administrador de Denuncias (React + Vite)

Frontend minimal para listar denuncias con login.

## Requisitos
- Node.js 18+
- Backend con endpoints:
  - `POST /api/auth/login` -> `{ token, user }`
  - `GET /api/denuncias` -> `{ items: [...], total: N }` con filtros: `page, pageSize, search, categoriaId, localidadId, privado`
  - `GET /api/categorias` -> `[{id, nombre}]`
  - `GET /api/localidades` -> `[{id, nombre}]`
  - `GET /api/usuarios` -> `[{id, nombre, email}]`

Cada `denuncia` debe traer al menos:
`{ id, descripcion, fecha_hora, ubicacion, categoria, adjunto, usuario, privado, localidad }`
donde `categoria`, `usuario`, `localidad` son IDs referenciando a las tablas homónimas.

## Configuración
1. Copiá `.env.example` a `.env` y ajustá `VITE_API_BASE_URL`.
2. Instalá dependencias: `npm i`
3. Levantá dev server: `npm run dev`

## Notas
- El token se guarda en `localStorage` y se envía como `Authorization: Bearer ...` en cada request.
- El campo `adjunto` se muestra como link. Si tu API entrega una ruta relativa (`/uploads/..`), asegurate que sea accesible por el navegador (CORS y static).
- Formato de fecha `dd/mm/aaaa hh:mm` en zona local del navegador.
