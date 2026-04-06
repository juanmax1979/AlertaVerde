import { Router } from 'express'
import { getPool, sql } from '../db.js'

const router = Router()

// GET /api/localidades → lista todas las localidades
router.get('/', async (_req, res) => {
  try {
    const pool = await getPool()
    const result = await pool.request()
      .query('SELECT id, localidad FROM [dbo].[localidades] ORDER BY localidad ASC')

    return res.json(result.recordset)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error al listar localidades' })
  }
})

// GET /api/localidades/:id → obtener una localidad puntual
router.get('/:id', async (req, res) => {
  const { id } = req.params
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('id', sql.Int, Number(id))
      .query('SELECT id, localidad FROM [dbo].[localidades] WHERE id = @id')

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Localidad no encontrada' })
    }

    return res.json(result.recordset[0])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error al obtener localidad' })
  }
})

export default router
