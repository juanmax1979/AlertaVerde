// Utilidades para claves de dbo.login (bcrypt; compatibilidad con texto plano legado).
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12)

export function hashPassword(plain) {
  const s = String(plain ?? '')
  if (!s) throw new Error('Clave vacía')
  return bcrypt.hashSync(s, BCRYPT_ROUNDS)
}

/** Hash bcrypt típico: $2a$, $2b$, $2y$ */
export function isBcryptHash(stored) {
  return typeof stored === 'string' && /^\$2[aby]\$\d{2}\$/.test(stored)
}

function legacyPlainEqual(stored, plain) {
  const ah = crypto.createHash('sha256').update(String(stored), 'utf8').digest()
  const bh = crypto.createHash('sha256').update(String(plain), 'utf8').digest()
  return crypto.timingSafeEqual(ah, bh)
}

/**
 * @returns {Promise<{ ok: boolean, upgradeToHash?: string }>}
 *   Si la clave en BD era texto plano y coincide, `upgradeToHash` es el bcrypt a persistir.
 */
export async function verifyPassword(plain, stored) {
  if (stored == null || stored === '') return { ok: false }

  if (isBcryptHash(stored)) {
    const ok = await bcrypt.compare(String(plain), stored)
    return { ok }
  }

  if (legacyPlainEqual(stored, plain)) {
    return { ok: true, upgradeToHash: hashPassword(plain) }
  }

  return { ok: false }
}
