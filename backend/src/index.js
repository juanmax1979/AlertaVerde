import express from 'express'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
import cors from 'cors'
import morgan from 'morgan'

import usuariosRouter from './routes/usuarios.js'
import authRouter from './routes/auth.js'
import categoriasRouter from './routes/categorias.js'
import denunciasRouter from './routes/denuncias.js'
import localidadesRouter from './routes/localidades.js'
import { verificarToken } from './middlewares/auth.js'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT || 3500)
// Puede venir como '*' o lista separada por comas
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*')
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads')

// ----------------- Middlewares base -----------------
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || CORS_ORIGIN === '*') return cb(null, true)
    const allowed = CORS_ORIGIN.split(',').map(s => s.trim())
    return cb(null, allowed.includes(origin))
  },
  allowedHeaders: ['Content-Type', 'Auth', 'Authorization'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  credentials: false
}))
app.use(morgan('dev'))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ----------------- Archivos estáticos / uploads -----------------
// Asegurar carpeta de uploads
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// Servir los adjuntos como /static/<archivo>
app.use('/static', express.static(UPLOAD_DIR, {
  fallthrough: true,
  maxAge: '7d',          // cache razonable
  immutable: false
}))

// ----------------- Rutas API -----------------
app.use('/api/auth', authRouter)

// Healthchecks (dos rutas por si el proxy consulta una u otra)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

app.use('/api/usuarios', verificarToken, usuariosRouter)
app.use('/api/categorias', verificarToken, categoriasRouter)
app.use('/api/denuncias', verificarToken, denunciasRouter)
app.use('/api/localidades',verificarToken, localidadesRouter) //verificarToken,

// 404
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }))

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Error interno del servidor' })
})

// ----------------- Bootstrap -----------------
app.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`)
  console.log(`Uploads en: ${UPLOAD_DIR} → servidos como /static/<archivo>`)
})
