#!/usr/bin/env node
/**
 * Genera un hash bcrypt para guardar en dbo.login.clave (INSERT/UPDATE manual).
 * Uso: node scripts/hash-login-clave.mjs "tu_clave_segura"
 */
import bcrypt from 'bcryptjs'

const rounds = Number(process.env.BCRYPT_ROUNDS || 12)
const plain = process.argv[2]

if (!plain) {
  console.error('Uso: node scripts/hash-login-clave.mjs "<clave>"')
  process.exit(1)
}

const hash = bcrypt.hashSync(plain, rounds)
console.log(hash)
console.log('\nEjemplo SQL:\n  UPDATE dbo.login SET clave = N\'' + hash.replace(/'/g, "''") + '\' WHERE login = N\'usuario\';')
