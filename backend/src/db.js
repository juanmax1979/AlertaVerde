import sql from 'mssql'
import dotenv from 'dotenv'
dotenv.config()

function parseBool(v, def = false) {
  if (v === undefined || v === null || v === '') return def
  return String(v).toLowerCase() === 'true'
}

const server = process.env.DB_SERVER || 'localhost'
const hasPort = !!process.env.DB_PORT && String(process.env.DB_PORT).trim() !== ''
const hasInstance = !!process.env.DB_INSTANCE && String(process.env.DB_INSTANCE).trim() !== ''

if (hasPort && hasInstance) {
  console.warn('[DB] Aviso: llegaron DB_PORT y DB_INSTANCE. Usaré DB_PORT y voy a ignorar DB_INSTANCE.')
}

const config = {
  server,                                // p.ej. host.docker.internal
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  ...(hasPort ? { port: Number(process.env.DB_PORT) } : {}),
  options: {
    ...(hasInstance && !hasPort ? { instanceName: process.env.DB_INSTANCE } : {}),
    encrypt: parseBool(process.env.DB_ENCRYPT, false),
    trustServerCertificate: parseBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
    enableArithAbort: true
  },
  pool: {
    max: Number(process.env.DB_POOL_MAX || 10),
    min: Number(process.env.DB_POOL_MIN || 0),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE || 30000)
  }
}

let poolPromise

export async function getPool () {
  if (!poolPromise) {
    poolPromise = sql.connect(config).catch(err => {
      // Log breve y seguro
      console.error('[DB] Error conectando:', err.code || err.name || err.message)
      // Re-lanzar para que la app pueda manejarlo
      throw err
    })
  }
  return poolPromise
}

export { sql }
