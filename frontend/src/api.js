// src/api.js
import axios from 'axios'

const RAW = (import.meta.env.VITE_API_BASE_URL || '').trim()

// BASE sin /api. Ej: "http://localhost:3500" o "/api" (si usás proxy)
const BASE =
  RAW !== ''
    ? (/^https?:\/\//i.test(RAW)
        ? RAW.replace(/\/+$/, '')
        : `/${RAW.replace(/^\/+/, '').replace(/\/+$/, '')}`)
    : '' // fallback: mismo origen (evita CORS en producci?n)

const api = axios.create({
  baseURL: BASE,
})

const API_KEY = import.meta.env.VITE_API_KEY || ''
const BASE_HAS_API_PREFIX = /(^|\/)api$/.test(BASE)

// ??? Export necesario (lo usan tus componentes)
export const toApiMediaUrl = (u) => {
  if (!u) return null
  if (/^https?:\/\//i.test(u)) return u

  const path = `/${String(u).replace(/^\/*/, '')}`

  // Static: backend sirve /static (sin /api)
  if (path.startsWith('/static/')) {
    // si BASE es absoluto => http://localhost:3500/static/...
    if (/^https?:\/\//i.test(BASE)) return `${BASE}${path}`
    // si BASE es relativo (/api) => devolvemos /static/... (misma origin con proxy)
    return path
  }

  // Para endpoints, armamos con /api adelante si corresponde.
  // Si BASE es absoluto (http://localhost:3500) => http://localhost:3500/api/...
  // Si BASE es relativo (/api) => /api/api/... (malo) si duplicamos; por eso acá NO se usa para endpoints comunes.
  // Este helper es solo para URLs de media; para endpoints usá api.get/post.
  if (/^https?:\/\//i.test(BASE)) return `${BASE}/api${path}`.replace(/\/{2,}/g, '/').replace(/^https:\//, 'https://').replace(/^http:\//, 'http://')
  // si BASE es "/api" por proxy, entonces endpoint debería ser "/api/..." ya desde el caller
  return `/api${path}`.replace(/\/{2,}/g, '/')
}

// Token en cada request si existe
api.interceptors.request.use((config) => {
  // Evita URLs duplicadas tipo /api/api/... cuando BASE ya incluye /api.
  if (BASE_HAS_API_PREFIX && typeof config.url === 'string') {
    config.url = config.url.replace(/^\/api(?=\/|$)/, '')
    if (!config.url.startsWith('/')) config.url = `/${config.url}`
  }
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  if (API_KEY) config.headers.Auth = API_KEY
  return config
})

// ---- Endpoints ----
// ??? correcto: backend monta /api/auth/login
export const loginRequest = async (login, clave) => {
  try {
    const { data } = await api.post('/auth/login', { login, clave })
    return data // { token, user }
  } catch (err) {
    const msg =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      'Error en autenticación'
    throw new Error(msg)
  }
}

export const fetchDenuncias = async () => {
  const { data } = await api.get('/denuncias')
  return data
}

export const fetchCategorias = async () => {
  const { data } = await api.get('/categorias')
  return data.map((c) => ({ id: c.id, nombre: c.descripcion || c.nombre }))
}

export const fetchLocalidades = async () => {
  const { data } = await api.get('/localidades')
  return data.map((l) => ({ id: l.id, nombre: l.localidad || l.nombre }))
}

export const fetchUsuarios = async () => {
  const { data } = await api.get('/usuarios')
  return data
}

export const fetchUsuarioByDni = async (dni) => {
  const { data } = await api.get(`/usuarios/dni/${encodeURIComponent(dni)}`)
  return data
}

export const downloadDenunciaPdf = async (id) => {
  const res = await api.get(`/denuncias/${id}/pdf`, { responseType: 'blob' })
  return res.data
}

export default api
