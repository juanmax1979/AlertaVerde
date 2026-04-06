import { Router } from 'express'
import { validationResult } from 'express-validator'
import { getPool, sql } from '../db.js'
import { usuarioCreateValidator, idParamValidator } from '../utils/validators.js'


const router = Router()


// Listar usuarios (id, nya, email, telefono)
router.get('/', async (_req, res) => {
try {
const pool = await getPool()
const result = await pool.request()
.query('SELECT id, nya, email, telefono FROM usuarios ORDER BY id DESC')
return res.json(result.recordset)
} catch (err) {
console.error(err)
return res.status(500).json({ error: 'Error al listar usuarios' })
}
})


// Crear usuario
router.post('/', usuarioCreateValidator, async (req, res) => {
const errors = validationResult(req)
if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })


const { nya, dni, email, telefono } = req.body
try {
const pool = await getPool()
const result = await pool.request()
.input('nya', sql.NVarChar(200), nya)
.input('dni', sql.NVarChar(50), dni)
.input('email', sql.NVarChar(200), email || null)
.input('telefono', sql.NVarChar(50), telefono || null)
.query(`
INSERT INTO usuarios (nya, dni, email, telefono)
OUTPUT INSERTED.id
VALUES (@nya, @dni, @email, @telefono)
`)


return res.status(201).json({ id: result.recordset[0].id, nya, dni, email, telefono })
} catch (err) {
console.error(err)
return res.status(500).json({ error: 'Error al crear usuario' })
}
})


// Obtener usuario por id
router.get('/:id', idParamValidator, async (req, res) => {
const errors = validationResult(req)
if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })


const { id } = req.params
try {
const pool = await getPool()
const result = await pool.request()
.input('id', sql.Int, Number(id))
.query('SELECT id, nya, dni, email, telefono FROM usuarios WHERE id = @id')


if (result.recordset.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' })
return res.json(result.recordset[0])
} catch (err) {
console.error(err)
return res.status(500).json({ error: 'Error al obtener usuario' })
}
})


// Obtener usuario por DNI
router.get('/dni/:dni', async (req, res) => {
const { dni } = req.params
if (!dni) return res.status(400).json({ error: 'dni requerido' })
try {
const pool = await getPool()
const result = await pool.request()
.input('dni', sql.NVarChar(50), String(dni))
.query('SELECT TOP 1 id, nya, dni, email, telefono FROM usuarios WHERE dni = @dni ORDER BY id DESC')
if (!result.recordset.length) return res.status(404).json({ error: 'Usuario no encontrado' })
return res.json(result.recordset[0])
} catch (err) {
console.error(err)
return res.status(500).json({ error: 'Error al obtener usuario por DNI' })
}
})


export default router