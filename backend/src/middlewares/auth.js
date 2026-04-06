// src/middlewares/auth.js
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import slowDown from 'express-slow-down'

dotenv.config()

const API_KEY = process.env.API_KEY 
const JWT_SECRET = process.env.JWT_SECRET 

// ======== Parámetros de protección (ajustables por .env) ========
const LOGIN_RATE_WINDOW_MS   = Number(process.env.LOGIN_RATE_WINDOW_MS   || 60_000)   // 1 min
const LOGIN_RATE_MAX_IP      = Number(process.env.LOGIN_RATE_MAX_IP      || 10)       // intentos/IP/min
const LOGIN_RATE_MAX_USER    = Number(process.env.LOGIN_RATE_MAX_USER    || 5)        // intentos/usuario/min

const LOGIN_SLOW_WINDOW_MS   = Number(process.env.LOGIN_SLOW_WINDOW_MS   || 5 * 60_000) // 5 min
const LOGIN_SLOW_DELAY_AFTER = Number(process.env.LOGIN_SLOW_DELAY_AFTER || 5)          // desde el 6º intento
const LOGIN_SLOW_DELAY_MS    = Number(process.env.LOGIN_SLOW_DELAY_MS    || 500)        // +500ms por intento extra
const LOGIN_SLOW_MAX_DELAY   = Number(process.env.LOGIN_SLOW_MAX_DELAY   || 5_000)      // tope 5s

const LOGIN_LOCK_THRESHOLD   = Number(process.env.LOGIN_LOCK_THRESHOLD   || 8)          // fallos en ventana
const LOGIN_LOCK_MS          = Number(process.env.LOGIN_LOCK_MS          || 15 * 60_000) // 15 min

// ======== Verificación de API key / JWT (igual que tenías) ========
export function verificarToken(req, res, next) {
  // 1) Encabezado "Auth" con API key (legacy)
  const apiKey = req.header('Auth')
  if (apiKey && apiKey === API_KEY) {
    req.auth = { type: 'api_key' }
    return next()
  }

  // 2) Authorization: Bearer <jwt>
  const authHeader = req.header('Authorization') || ''
  const [scheme, token] = authHeader.split(' ')
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      req.user = payload
      req.auth = { type: 'jwt' }
      return next()
    } catch {
      return res.status(401).json({ error: 'Token inválido' })
    }
  }

  return res.status(401).json({ error: 'No autorizado' })
}

// ======== Rate limit por IP (para /api/auth/login) ========
export const loginRateLimitIP = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX_IP,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
  message: { error: 'Demasiados intentos desde esta IP. Intente más tarde.' },
})

// ======== Rate limit por usuario (username/email) ========
export const loginRateLimitUser = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX_USER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Ajustá los nombres según tu payload de login
    const u = (req.body?.username || req.body?.email || '').toLowerCase().trim()
    return u || `anon@${ipKeyGenerator(req)}`
  },
  skipFailedRequests: false, // contamos todos los intentos
  message: { error: 'Demasiados intentos para este usuario. Intente más tarde.' },
})

// ======== Slow-down progresivo (añade delay tras varios intentos) ========
export const loginSpeedLimiter = slowDown({
  windowMs: LOGIN_SLOW_WINDOW_MS,
  delayAfter: LOGIN_SLOW_DELAY_AFTER,
  delayMs: (hits) => Math.min((hits - LOGIN_SLOW_DELAY_AFTER + 1) * LOGIN_SLOW_DELAY_MS, LOGIN_SLOW_MAX_DELAY),
})

// ======== Bloqueo temporal tras múltiples fallos ========
// In-memory (si usás múltiples instancias, conviene Redis)
const failedMap = new Map() // key -> { fails, lockedUntil, windowStart }
const FAIL_WINDOW_MS = LOGIN_SLOW_WINDOW_MS // reutilizamos la ventana del slow-down

function keyFromReq(req) {
  const u = (req.body?.username || req.body?.email || '').toLowerCase().trim() || 'anon'
  return `${u}::${ipKeyGenerator(req)}`
}

export function checkLoginLock(req, res, next) {
  const key = keyFromReq(req)
  const rec = failedMap.get(key)
  const now = Date.now()
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000)
    return res.status(429).json({ error: `Cuenta/IP bloqueada temporalmente. Reintente en ${secs}s.` })
  }
  return next()
}

// Llamar en el controlador de login cuando el password es INCORRECTO
export function registerLoginFailure(req) {
  const key = keyFromReq(req)
  const now = Date.now()
  const rec = failedMap.get(key) || { fails: 0, lockedUntil: 0, windowStart: now }

  // reset ventana si expiró
  if (now - rec.windowStart > FAIL_WINDOW_MS) {
    rec.fails = 0
    rec.windowStart = now
    rec.lockedUntil = 0
  }

  rec.fails += 1

  if (rec.fails >= LOGIN_LOCK_THRESHOLD) {
    rec.lockedUntil = now + LOGIN_LOCK_MS
  }

  failedMap.set(key, rec)
}

// Llamar en el controlador de login cuando el password es CORRECTO
export function resetLoginFailures(req) {
  const key = keyFromReq(req)
  failedMap.delete(key)
}
