// src/routes/denuncias.js
import { Router } from 'express'
import { validationResult } from 'express-validator'
import { getPool, sql } from '../db.js'
import {
  denunciaCreateValidator,
  idParamValidator,
  denunciasQueryByUsuario
} from '../utils/validators.js'
import { mediaUpload } from '../middlewares/upload.js'
import { sendDenunciaEmail } from '../services/mailer.js'
import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads')

/** Carga un adjunto ("/static/..." o URL) a Buffer; convierte WEBP/BMP -> PNG si hay sharp */
async function loadAdjuntoBuffer(adjunto, baseUrl) {
  if (!adjunto) return null

  const isAbsolute = /^https?:\/\//i.test(adjunto)
  let data = null
  let mime = null

  if (!isAbsolute) {
    const pub = String(adjunto)
    const fname = pub.startsWith('/static/') ? pub.slice('/static/'.length) : pub
    const full = path.join(UPLOAD_DIR, fname)
    if (!fs.existsSync(full)) return null
    data = await fs.promises.readFile(full)

    const ext = path.extname(fname).toLowerCase()
    mime = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp'
      : null
  } else {
    const url = adjunto
    const resp = await fetch(url)
    if (!resp.ok) return null
    const ab = await resp.arrayBuffer()
    data = Buffer.from(ab)
    mime = resp.headers.get('content-type') || ''
  }

  const supported = mime && (mime.includes('png') || mime.includes('jpeg') || mime.includes('jpg'))
  if (supported) return data

  if (mime && (mime.includes('webp') || mime.includes('bmp'))) {
    try {
      const { default: sharp } = await import('sharp')
      return await sharp(data).png().toBuffer()
    } catch (e) {
      console.warn('[PDF] No se pudo convertir imagen (¿falta sharp?):', e?.message || e)
      return null
    }
  }
  return null
}

const router = Router()

/**
 * POST /api/denuncias
 * Crea denuncia con hasta 3 imágenes + 1 video
 * - Compatibilidad: guarda 1ª imagen en denuncias.adjunto
 * - Todos los adjuntos en dbo.denuncias_adjuntos
 */
router.post('/', mediaUpload(), denunciaCreateValidator, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { descripcion, ubicacion, categoria, localidad } = req.body
  let { usuario, privado } = req.body

  // Datos de media del middleware (consistente con upload.js actualizado)
  // req.savedAll: [{ tipo:'image'|'video', fileName, mime, bytes, orden }, ...]
  const savedAll = Array.isArray(req.savedAll) ? req.savedAll : []
  const firstImage = savedAll.find(a => a.tipo === 'image') || null
  const adjuntoPath = firstImage ? `/static/${firstImage.fileName}` : null // legacy

  // Normalizaciones
  privado = String(privado ?? '').toLowerCase()
  const esPrivado = (privado === 'true' || privado === '1')

  const catNum = Number.parseInt(String(categoria ?? '').trim(), 10)
  const locNum = Number.parseInt(String(localidad ?? '').trim(), 10)

  const dniNum = Number.parseInt(String(usuario ?? '').trim(), 10)
  const usuarioOk = !Number.isNaN(dniNum) && dniNum > 0

  if (!catNum) return res.status(400).json({ error: 'categoria es requerida y debe ser > 0' })
  if (!locNum) return res.status(400).json({ error: 'localidad es requerida y debe ser > 0' })
  if (!usuarioOk) return res.status(400).json({ error: 'usuario (DNI) es requerido y debe ser numérico > 0' })

  try {
    const pool = await getPool()
    const tx = await pool.transaction()
    await tx.begin()

    try {
      // Insert principal
      const r1 = await tx.request()
        .input('descripcion', sql.NVarChar(sql.MAX), descripcion)
        .input('ubicacion',   sql.NVarChar(500),    ubicacion)
        .input('categoria',   sql.Int,              catNum)
        .input('localidad',   sql.Int,              locNum)
        .input('usuario',     sql.Int,              dniNum)
        .input('adjunto',     sql.NVarChar(255),    adjuntoPath)
        .input('privado',     sql.Bit,              esPrivado ? 1 : 0)
        .query(`
          INSERT INTO [dbo].[denuncias]
            (descripcion, fecha_hora, ubicacion, categoria, localidad, adjunto, usuario, privado)
          OUTPUT INSERTED.id, INSERTED.fecha_hora, INSERTED.adjunto, INSERTED.privado, INSERTED.usuario, INSERTED.localidad
          VALUES (@descripcion, GETDATE(), @ubicacion, @categoria, @localidad, @adjunto, @usuario, @privado)
        `)

      const row = r1.recordset[0]
      const denunciaId = Number(row.id)

      // Insert adjuntos en la tabla hija
      if (savedAll.length) {
        const ps = new sql.PreparedStatement(tx)
        await ps.input('denuncia_id', sql.Int)
        await ps.input('tipo', sql.VarChar(10))
        await ps.input('ruta', sql.NVarChar(255))
        await ps.input('mime', sql.VarChar(100))
        await ps.input('bytes', sql.BigInt)     // <-- BigInt para tamaños grandes
        await ps.input('orden', sql.Int)
        await ps.prepare(`
          INSERT INTO dbo.denuncias_adjuntos (denuncia_id, tipo, ruta, mime, bytes, orden)
          VALUES (@denuncia_id, @tipo, @ruta, @mime, @bytes, @orden)
        `)

        for (const a of savedAll) {
          await ps.execute({
            denuncia_id: denunciaId,
            tipo: a.tipo, // 'image' | 'video'
            ruta: `/static/${a.fileName}`,
            mime: a.mime || null,
            bytes: a.bytes != null ? Number(a.bytes) : null,
            orden: a.orden || 1
          })
        }
        await ps.unprepare()
      }

      await tx.commit()

      // ——————————  AUTO-NOTIFICACIÓN POR EMAIL (resumen adjuntos)  ——————————
      try {
        const shouldNotify = String(process.env.EMAIL_ON_CREATE || 'true') === 'true'
        if (shouldNotify) {
          // Datos de la denuncia + emails
          const denQ = await pool.request()
            .input('id', sql.Int, denunciaId)
            .query(`
              SELECT
                d.id,
                d.descripcion,
                d.fecha_hora,
                d.ubicacion,
                d.privado,
                d.categoria              AS categoria_id,
                c.descripcion            AS categoria,
                d.localidad              AS localidad_id,
                lo.localidad             AS localidad,
                lo.correo                AS localidad_email,
                d.usuario                AS usuario_dni,
                u.nya                    AS usuario_nya,
                u.email                  AS usuario_email
              FROM [dbo].[denuncias] d
              LEFT JOIN [dbo].[categorias]  c  ON c.id  = d.categoria
              LEFT JOIN [dbo].[localidades] lo ON lo.id = d.localidad
              LEFT JOIN [dbo].[usuarios]    u  ON u.dni = d.usuario
              WHERE d.id = @id
            `)

          if (denQ.recordset.length) {
            const den = denQ.recordset[0]
            const imgsQ = await pool.request()
              .input('id', sql.Int, denunciaId)
              .query(`SELECT COUNT(*) AS n FROM dbo.denuncias_adjuntos WHERE denuncia_id=@id AND tipo='image'`)
            const vidsQ = await pool.request()
              .input('id', sql.Int, denunciaId)
              .query(`SELECT COUNT(*) AS n FROM dbo.denuncias_adjuntos WHERE denuncia_id=@id AND tipo='video'`)

            const cantImgs = imgsQ.recordset[0].n
            const cantVids = vidsQ.recordset[0].n

            const fecha = new Date(den.fecha_hora).toLocaleString('es-AR')
            const subject = `Denuncia #${den.id} registrada`
            const text = `
Hola ${den.usuario_nya || ''},

Se registró una nueva denuncia.

Número: ${den.id}
Fecha y hora: ${fecha}
Categoría: ${den.categoria}
Localidad: ${den.localidad}
Ubicación: ${den.ubicacion}
Imágenes: ${cantImgs}
Video: ${cantVids > 0 ? 'SI' : 'NO'}

Descripción:
${den.descripcion}

Gracias por usar Alerta Verde.
            `.trim()

            const html = `
<p>Hola <strong>${den.usuario_nya || ''}</strong>,</p>
<p>Se registró una nueva denuncia.</p>
<ul>
  <li><strong>Número:</strong> ${den.id}</li>
  <li><strong>Fecha y hora:</strong> ${fecha}</li>
  <li><strong>Categoría:</strong> ${den.categoria}</li>
  <li><strong>Localidad:</strong> ${den.localidad}</li>
  <li><strong>Ubicación:</strong> ${den.ubicacion}</li>
  <li><strong>Imágenes:</strong> ${cantImgs}</li>
  <li><strong>Video:</strong> ${cantVids > 0 ? 'SI' : 'NO'}</li>
</ul>
<p><strong>Descripción:</strong></p>
<pre style="white-space:pre-wrap;font-family:inherit">${den.descripcion}</pre>
<p>Gracias por usar <strong>Alerta Verde</strong>.</p>
            `

            const toList = []
            const ccList = []
            if (den.localidad_email) toList.push(den.localidad_email)
            if (den.usuario_email)   ccList.push(den.usuario_email)

            if (toList.length || ccList.length) {
              await sendDenunciaEmail({
                to: toList.join(','),
                cc: ccList.length ? ccList.join(',') : undefined,
                subject,
                text,
                html
              })
            } else {
              console.warn('[EMAIL] No hay destinatarios para notificación.')
            }
          }
        }
      } catch (mailErr) {
        console.error('[EMAIL] Error al enviar notificación:', mailErr)
      }
      // ————————————————————————————————————————————————

      return res.status(201).json({
        id: row.id,
        descripcion,
        fecha_hora: row.fecha_hora,
        ubicacion,
        categoria: catNum,
        localidad: row.localidad,
        adjunto: row.adjunto, // compat: 1ª imagen
        privado: !!row.privado,
        usuario: row.usuario
      })
    } catch (e) {
      try { await tx.rollback() } catch {}
      throw e
    }
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error al crear denuncia' })
  }
})

/**
 * GET /api/denuncias?usuario_id=...
 * Devuelve lista + adjuntos[] (urls públicas)
 */
router.get('/', denunciasQueryByUsuario, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { usuario_id } = req.query
  try {
    const pool = await getPool()

    let query = `
      SELECT DISTINCT
        d.id,
        d.descripcion,
        d.fecha_hora,
        d.ubicacion,
        d.categoria         AS categoria_id,
        c.descripcion       AS categoria,
        d.localidad         AS localidad_id,
        lo.localidad        AS localidad,
        d.adjunto,
        d.privado,
        d.usuario           AS usuario_dni,
        u.id                AS usuario_id,
        u.nya               AS usuario_nya
      FROM [dbo].[denuncias] d
      LEFT JOIN [dbo].[categorias]  c  ON c.id  = d.categoria
      LEFT JOIN [dbo].[localidades] lo ON lo.id = d.localidad
      LEFT JOIN (
        SELECT u2.id, u2.nya, u2.dni
        FROM [dbo].[usuarios] u2
        INNER JOIN (
          SELECT dni, MAX(id) AS max_id
          FROM [dbo].[usuarios]
          GROUP BY dni
        ) sel ON sel.max_id = u2.id
      ) u ON u.dni = d.usuario
    `
    if (usuario_id) query += ' WHERE d.usuario = @usuario_id'
    query += ' ORDER BY d.fecha_hora DESC'

    const result = await pool.request()
      .input('usuario_id', sql.Int, usuario_id ? Number(usuario_id) : null)
      .query(query)

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3500}`
    const rows = result.recordset

    // Cargar adjuntos por lote
    let adjMap = new Map()
    if (rows.length) {
      const ids = rows.map(r => r.id)
      const adj = await pool.request().query(`
        SELECT denuncia_id, tipo, ruta, mime, bytes, orden
        FROM dbo.denuncias_adjuntos
        WHERE denuncia_id IN (${ids.join(',')})
        ORDER BY denuncia_id, tipo, orden
      `)
      for (const a of adj.recordset) {
        const list = adjMap.get(a.denuncia_id) || []
        list.push({
          tipo: a.tipo,
          url: String(a.ruta).startsWith('http') ? a.ruta : a.ruta, // => '/static/xxx', String(a.ruta).startsWith('http') ? a.ruta : `${baseUrl}${a.ruta}`,
          mime: a.mime,
          bytes: a.bytes,
          orden: a.orden
        })
        adjMap.set(a.denuncia_id, list)
      }
    }

    const items = rows.map(r => ({
      ...r,
      adjunto: r.adjunto ? (String(r.adjunto).startsWith('http') ? r.adjunto : r.adjunto) : null, //adjunto: r.adjunto ? (String(r.adjunto).startsWith('http') ? r.adjunto : `${baseUrl}${r.adjunto}`) : null,
      adjuntos: adjMap.get(r.id) || []
    }))

    return res.json(items)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error al listar denuncias' })
  }
})

/**
 * GET /api/denuncias/:id/adjuntos
 * Lista plana para el panel (antes el frontend llamaba esta URL y no existía → 404).
 * Incluye filas de denuncias_adjuntos y, si no hay ninguna, el adjunto legacy en denuncias.adjunto.
 */
router.get('/:id/adjuntos', idParamValidator, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { id } = req.params
  try {
    const pool = await getPool()

    const rowResult = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`SELECT adjunto FROM dbo.denuncias WHERE id=@id`)

    if (rowResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Denuncia no encontrada' })
    }

    const legacyAdjunto = rowResult.recordset[0].adjunto

    const adj = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`
        SELECT tipo, ruta, mime, bytes, orden
        FROM dbo.denuncias_adjuntos
        WHERE denuncia_id=@id
        ORDER BY tipo, orden
      `)

    let imgCount = 0
    const items = adj.recordset.map((a) => {
      const isVideo = String(a.tipo).toLowerCase() === 'video'
      if (!isVideo) imgCount += 1
      return {
        tipo: a.tipo,
        url: a.ruta,
        ruta: a.ruta,
        mime: a.mime || (isVideo ? 'video/mp4' : 'image/jpeg'),
        bytes: a.bytes,
        orden: a.orden,
        nombre: isVideo ? 'Video' : `Imagen ${imgCount}`,
      }
    })

    if (items.length === 0 && legacyAdjunto) {
      items.push({
        tipo: 'image',
        url: legacyAdjunto,
        ruta: legacyAdjunto,
        mime: 'image/jpeg',
        orden: 1,
        nombre: 'Imagen 1',
      })
    }

    return res.json(items)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error al listar adjuntos' })
  }
})

/**
 * GET /api/denuncias/:id
 * Devuelve denuncia + adjuntos[] (urls públicas)
 */
router.get('/:id', idParamValidator, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { id } = req.params
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`
        SELECT
          d.id,
          d.descripcion,
          d.fecha_hora,
          d.ubicacion,
          d.categoria         AS categoria_id,
          c.descripcion       AS categoria,
          d.localidad         AS localidad_id,
          lo.localidad        AS localidad,
          d.adjunto,
          d.privado,
          d.usuario           AS usuario_dni,
          u.id                AS usuario_id,
          u.nya               AS usuario_nya
        FROM [dbo].[denuncias] d
        LEFT JOIN [dbo].[categorias]  c  ON c.id  = d.categoria
        LEFT JOIN [dbo].[localidades] lo ON lo.id = d.localidad
        LEFT JOIN [dbo].[usuarios]    u  ON u.dni = d.usuario
        WHERE d.id = @id
      `)

    if (result.recordset.length === 0) return res.status(404).json({ error: 'Denuncia no encontrada' })

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3500}`
    const row = result.recordset[0]
    const adjCompat = row.adjunto ? (String(row.adjunto).startsWith('http') ? row.adjunto : row.adjunto) : null //adjCompat = row.adjunto ? (String(row.adjunto).startsWith('http') ? row.adjunto : `${baseUrl}${row.adjunto}`) : null

    // Adjuntos de la denuncia
    const adj = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`
        SELECT tipo, ruta, mime, bytes, orden
        FROM dbo.denuncias_adjuntos
        WHERE denuncia_id=@id
        ORDER BY tipo, orden
      `)

    const adjuntos = adj.recordset.map(a => ({
      tipo: a.tipo,
      url: String(a.ruta).startsWith('http') ? a.ruta : a.ruta, //url: String(a.ruta).startsWith('http') ? a.ruta : `${baseUrl}${a.ruta}`,
      mime: a.mime,
      bytes: a.bytes,
      orden: a.orden
    }))

    return res.json({ ...row, adjunto: adjCompat, adjuntos })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error al obtener denuncia' })
  }
})

/**
 * POST /api/denuncias/:id/notificar
 * Reenvía notificación con contadores de adjuntos (sin URLs)
 */
router.post('/:id/notificar', idParamValidator, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { id } = req.params

  try {
    const pool = await getPool()

    const q = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`
        SELECT
          d.id,
          d.descripcion,
          d.fecha_hora,
          d.ubicacion,
          d.privado,
          d.categoria              AS categoria_id,
          c.descripcion            AS categoria,
          d.localidad              AS localidad_id,
          lo.localidad             AS localidad,
          lo.correo                AS localidad_email,
          d.usuario                AS usuario_dni,
          u.nya                    AS usuario_nya,
          u.email                  AS usuario_email
        FROM [dbo].[denuncias] d
        LEFT JOIN [dbo].[categorias]  c  ON c.id  = d.categoria
        LEFT JOIN [dbo].[localidades] lo ON lo.id = d.localidad
        LEFT JOIN [dbo].[usuarios]    u  ON u.dni = d.usuario
        WHERE d.id = @id
      `)

    if (q.recordset.length === 0) {
      return res.status(404).json({ error: 'Denuncia no encontrada' })
    }
    const den = q.recordset[0]

    const imgsQ = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`SELECT COUNT(*) AS n FROM dbo.denuncias_adjuntos WHERE denuncia_id=@id AND tipo='image'`)
    const vidsQ = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`SELECT COUNT(*) AS n FROM dbo.denuncias_adjuntos WHERE denuncia_id=@id AND tipo='video'`)

    const cantImgs = imgsQ.recordset[0].n
    const cantVids = vidsQ.recordset[0].n
    const fecha = new Date(den.fecha_hora).toLocaleString('es-AR')

    const subject = `Denuncia #${den.id} registrada`
    const text = `
Hola ${den.usuario_nya || ''},

Tu denuncia fue registrada con éxito.

Número: ${den.id}
Fecha y hora: ${fecha}
Categoría: ${den.categoria}
Localidad: ${den.localidad}
Ubicación: ${den.ubicacion}
Imágenes: ${cantImgs}
Video: ${cantVids > 0 ? 'SI' : 'NO'}

Descripción:
${den.descripcion}

Gracias por usar Alerta Verde.
    `.trim()

    const html = `
<p>Hola <strong>${den.usuario_nya || ''}</strong>,</p>
<p>Tu denuncia fue registrada con éxito.</p>
<ul>
  <li><strong>Número:</strong> ${den.id}</li>
  <li><strong>Fecha y hora:</strong> ${fecha}</li>
  <li><strong>Categoría:</strong> ${den.categoria}</li>
  <li><strong>Localidad:</strong> ${den.localidad}</li>
  <li><strong>Ubicación:</strong> ${den.ubicacion}</li>
  <li><strong>Imágenes:</strong> ${cantImgs}</li>
  <li><strong>Video:</strong> ${cantVids > 0 ? 'SI' : 'NO'}</li>
</ul>
<p><strong>Descripción:</strong></p>
<pre style="white-space:pre-wrap;font-family:inherit">${den.descripcion}</pre>
<p>Gracias por usar <strong>Alerta Verde</strong>.</p>
    `

    const toList = []
    const ccList = []
    if (den.localidad_email) toList.push(den.localidad_email)
    if (den.usuario_email)   ccList.push(den.usuario_email)
    const info = await sendDenunciaEmail({
      to: toList.join(','),
      cc: ccList.length ? ccList.join(',') : undefined,
      subject,
      text,
      html
    })

    return res.json({ ok: true, messageId: info?.messageId })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'No se pudo enviar el email' })
  }
})

/**
 * GET /api/denuncias/:id/pdf
 * Inserta hasta 3 imágenes. Nota si hay video.
 */
router.get('/:id/pdf', async (req, res) => {
  const { id } = req.params
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`
        SELECT
          d.id,
          d.descripcion,
          d.fecha_hora,
          d.ubicacion,
          d.privado,
          d.categoria              AS categoria_id,
          c.descripcion            AS categoria,
          d.localidad              AS localidad_id,
          lo.localidad             AS localidad,
          d.usuario                AS usuario_dni,
          u.nya                    AS usuario_nya,
          u.email                  AS usuario_email,
          u.telefono               AS usuario_telefono
        FROM [dbo].[denuncias] d
        LEFT JOIN [dbo].[categorias]  c  ON c.id  = d.categoria
        LEFT JOIN [dbo].[localidades] lo ON lo.id = d.localidad
        LEFT JOIN [dbo].[usuarios]    u  ON u.dni = d.usuario
        WHERE d.id = @id
      `)

    if (!result.recordset.length) {
      return res.status(404).json({ error: 'Denuncia no encontrada' })
    }
    const den = result.recordset[0]

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3500}`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="denuncia_${id}.pdf"`)

    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    doc.pipe(res)

    // Encabezado
    doc
      .fontSize(18).text(`Denuncia #${den.id}`, { align: 'center' })
      .moveDown(0.5)
      .fontSize(10).text(`Fecha y hora: ${new Date(den.fecha_hora).toLocaleString('es-AR')}`, { align: 'center' })
      .moveDown(1)

    // Datos
    doc.fontSize(12).text(`Categoría: ${den.categoria || '-'}`)
    doc.text(`Localidad: ${den.localidad || '-'}`)
    doc.text(`Ubicación: ${den.ubicacion || '-'}`)
    doc.text(`Privado: ${den.privado ? 'Sí' : 'No'}`)
    doc.text(`Usuario (DNI): ${den.usuario_dni || '-'}`)
    if (den.usuario_nya) doc.text(`Nombre: ${den.usuario_nya}`)
    if (den.usuario_email) doc.text(`Email: ${den.usuario_email}`)
    if (den.usuario_telefono) doc.text(`Teléfono: ${den.usuario_telefono}`)
    doc.moveDown(1)

    doc.fontSize(12).text('Descripción:', { underline: true })
    doc.fontSize(11).text(den.descripcion || '-', { align: 'left' })
    doc.moveDown(1)

    // Adjuntos (hasta 3 imágenes) + nota si hay video
    const adj = await pool.request()
      .input('id', sql.Int, Number(id))
      .query(`
        SELECT tipo, ruta, orden
        FROM dbo.denuncias_adjuntos
        WHERE denuncia_id=@id
        ORDER BY tipo, orden
      `)

    const imgs = adj.recordset.filter(a => a.tipo === 'image').slice(0, 3)
    const hasVideo = adj.recordset.some(a => a.tipo === 'video')

    for (const [i, img] of imgs.entries()) {
      const buf = await loadAdjuntoBuffer(img.ruta, baseUrl)
      if (buf) {
        doc.addPage()
        doc.fontSize(14).text(`Adjunto (imagen ${i + 1})`, { align: 'left' }).moveDown(0.5)
        const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right
        const maxH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 24
        doc.image(buf, { fit: [maxW, maxH], align: 'center', valign: 'center' })
      } else {
        doc.addPage()
        doc.fontSize(10).fillColor('red').text(`No se pudo insertar la imagen ${i + 1} (formato no soportado o error de lectura).`)
        doc.fillColor('black')
      }
    }

    if (hasVideo) {
      doc.addPage()
      doc.fontSize(12).fillColor('gray').text('Hay video adjunto (no se incrusta en el PDF).', { align: 'left' })
      doc.fillColor('black')
    }

    doc.end()
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'No se pudo generar el PDF' })
  }
})

export default router
