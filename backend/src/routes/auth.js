// routes/auth.js
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import slowDown from 'express-slow-down'
import crypto from 'node:crypto'
import { getPool, sql } from '../db.js'

dotenv.config()

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h'

// -------- Parámetros de defensa (ajustables por .env) --------
const LOGIN_RATE_WINDOW_MS   = Number(process.env.LOGIN_RATE_WINDOW_MS   || 60_000)
const LOGIN_RATE_MAX_IP      = Number(process.env.LOGIN_RATE_MAX_IP      || 10)
const LOGIN_RATE_MAX_USER    = Number(process.env.LOGIN_RATE_MAX_USER    || 5)

const LOGIN_SLOW_WINDOW_MS   = Number(process.env.LOGIN_SLOW_WINDOW_MS   || 5 * 60_000)
const LOGIN_SLOW_DELAY_AFTER = Number(process.env.LOGIN_SLOW_DELAY_AFTER || 5)
const LOGIN_SLOW_DELAY_MS    = Number(process.env.LOGIN_SLOW_DELAY_MS    || 500)
const LOGIN_SLOW_MAX_DELAY   = Number(process.env.LOGIN_SLOW_MAX_DELAY   || 5_000)

const LOGIN_LOCK_THRESHOLD   = Number(process.env.LOGIN_LOCK_THRESHOLD   || 8)
const LOGIN_LOCK_MS          = Number(process.env.LOGIN_LOCK_MS          || 15 * 60_000)

const FAIL_WINDOW_MS         = LOGIN_SLOW_WINDOW_MS
const MIN_FIXED_DELAY_MS     = Number(process.env.LOGIN_MIN_DELAY_MS     || 200)

// -------- Helpers de seguridad --------
function normLogin(req) {
  return (req.body?.login || req.body?.email || '').toLowerCase().trim()
}

function keyFromReq(req) {
  return `${normLogin(req) || 'anon'}::${ipKeyGenerator(req)}`
}

function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a), 'utf8').digest()
  const bh = crypto.createHash('sha256').update(String(b), 'utf8').digest()
  return crypto.timingSafeEqual(ah, bh)
}

function fixedDelay() {
  return new Promise((resolve) => setTimeout(resolve, MIN_FIXED_DELAY_MS))
}

// -------- Estructuras en memoria --------
const failedMap = new Map()

function registerLoginFailure(req) {
  const key = keyFromReq(req)
  const now = Date.now()
  const rec = failedMap.get(key) || { fails: 0, lockedUntil: 0, windowStart: now }

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

function resetLoginFailures(req) {
  const key = keyFromReq(req)
  failedMap.delete(key)
}

function checkLoginLock(req, res, next) {
  const key = keyFromReq(req)
  const rec = failedMap.get(key)
  const now = Date.now()
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000)
    return res.status(429).json({ message: `Bloqueado temporalmente. Reintente en ${secs}s.` })
  }
  return next()
}

// -------- Rate limiting y slowdown --------
const loginRateLimitIP = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX_IP,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
  message: { message: 'Demasiados intentos desde esta IP. Intente más tarde.' },
})

const loginRateLimitUser = rateLimit({
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX_USER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => normLogin(req) || `anon@${ipKeyGenerator(req)}`,
  skipSuccessfulRequests: false,
  message: { message: 'Demasiados intentos para este usuario. Intente más tarde.' },
})

const loginSpeedLimiter = slowDown({
  windowMs: LOGIN_SLOW_WINDOW_MS,
  delayAfter: LOGIN_SLOW_DELAY_AFTER,
  delayMs: (hits) =>
    Math.min((hits - LOGIN_SLOW_DELAY_AFTER + 1) * LOGIN_SLOW_DELAY_MS, LOGIN_SLOW_MAX_DELAY),
})

// ================== POST /api/auth/login ==================
router.post(
  '/login',
  loginRateLimitIP,
  loginRateLimitUser,
  loginSpeedLimiter,
  checkLoginLock,
  async (req, res) => {
    const login = normLogin(req)
    const clave = (req.body?.clave || '').trim()

    if (!login || !clave) {
      return res.status(400).json({ message: 'Usuario y contraseña son requeridos' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('login', sql.NVarChar(200), login)
        .query(`
          SELECT TOP 1 id, login, clave, localidad
          FROM dbo.login
          WHERE login = @login
        `)

      const row = result.recordset[0]

      // Mitigación user-enum
      if (!row) {
        await fixedDelay()
        registerLoginFailure(req)
        return res.status(401).json({ message: 'Credenciales inválidas' })
      }

      // Comparación en tiempo constante (DB en texto plano)
      const passwordOk = safeEqual(row.clave, clave)

      if (!passwordOk) {
        await fixedDelay()
        registerLoginFailure(req)
        return res.status(401).json({ message: 'Credenciales inválidas' })
      }

      // Éxito
      resetLoginFailures(req)

      // ✅ incluimos localidad
      const user = {
        id: row.id,
        login: row.login,
        localidad: row.localidad, // ej. "Campo Largo"
      }

      // ✅ metemos localidad en el JWT para enforcement posterior
      const token = jwt.sign(
        { sub: String(user.id), login: user.login, localidad: user.localidad },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      )

      return res.json({ token, user })
    } catch (err) {
      console.error('Login error:', err)
      return res.status(500).json({ message: 'Error en autenticación' })
    }
  }
)

export default router
