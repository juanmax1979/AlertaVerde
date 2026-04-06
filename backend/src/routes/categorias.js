// src/routes/categorias.js
import { Router } from 'express'
import { validationResult } from 'express-validator'
import { getPool, sql } from '../db.js'
import { categoriaCreateValidator, idParamValidator } from '../utils/validators.js'

const router = Router()

// Listar todas
router.get('/', async (_req, res) => {
  try {
    const pool = await getPool()
    const result = await pool.request()
      .query('SELECT id, descripcion FROM categorias ORDER BY id')
    res.json(result.recordset)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al listar categorías' })
  }
})

// Crear (opcional)
router.post('/', categoriaCreateValidator, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { descripcion } = req.body
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('descripcion', sql.NVarChar(200), descripcion)
      .query('INSERT INTO categorias (descripcion) OUTPUT INSERTED.id VALUES (@descripcion)')
    res.status(201).json({ id: result.recordset[0].id, descripcion })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear categoría' })
  }
})

// Obtener por id
router.get('/:id', idParamValidator, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { id } = req.params
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('id', sql.Int, Number(id))
      .query('SELECT id, descripcion FROM categorias WHERE id = @id')

    if (result.recordset.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' })
    res.json(result.recordset[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener categoría' })
  }
})

export default router
