// src/middlewares/upload.js
import dotenv from 'dotenv'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileTypeFromBuffer } from 'file-type'
dotenv.config()

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// ====== Config general ======
const MAX_IMAGE_BYTES = 5 * 1024 * 1024      // 5 MB por imagen
const MAX_VIDEO_BYTES = 15 * 1024 * 1024     // 15 MB máx. video (requisito)

const ALLOWED_IMG = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp'])
const ALLOWED_VIDEO = new Set(['video/mp4', 'video/webm', 'video/ogg'])

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv'
}

function slugifyBase (s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'archivo'
}

function uniqueName (ext = '') {
  const ts = Date.now()
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${ts}_${rnd}${ext ? '.' + ext : ''}`
}

async function saveBuffer (buffer, { originalName = '' } = {}) {
  const ft = await fileTypeFromBuffer(buffer).catch(() => null)
  const mime = (ft?.mime || '').toLowerCase()
  const parsed = path.parse(originalName || '')
  const baseName = slugifyBase(parsed.name || 'archivo')
  const ext = EXT_BY_MIME[mime] || ft?.ext || 'bin'
  const name = `${baseName}_${uniqueName(ext)}`
  const full = path.join(UPLOAD_DIR, name)
  await fs.promises.writeFile(full, buffer, { flag: 'wx' })
  return { fileName: name, fullPath: full, mime, bytes: buffer.length }
}

// ============= COMPAT: una sola imagen (tu middleware original) =============
const _multerSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mm = (file.mimetype || '').toLowerCase()
    if (mm.startsWith('image/')) return cb(null, true)
    return cb(new Error('Solo se aceptan imágenes (jpg, png, bmp, webp).'))
  }
})

export const imageUpload = (fieldName = 'adjunto') => (req, res, next) => {
  _multerSingleImage.single(fieldName)(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `Archivo supera ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB` })
        }
        return res.status(400).json({ error: `Error de carga: ${err.message}` })
      }
      return res.status(415).json({ error: 'Solo se aceptan imágenes (jpg, png, bmp, webp).' })
    }

    if (!req.file || !req.file.buffer) {
      req.fileName = null
      req.filePath = null
      return next()
    }

    try {
      const ft = await fileTypeFromBuffer(req.file.buffer)
      const mime = (ft?.mime || '').toLowerCase()
      if (!ft || !ALLOWED_IMG.has(mime)) {
        return res.status(415).json({ error: 'Tipo no permitido. Solo imágenes válidas (jpg, png, webp, bmp).' })
      }

      const saved = await saveBuffer(req.file.buffer, { originalName: req.file.originalname })
      req.fileName = saved.fileName
      req.filePath = saved.fullPath
      return next()
    } catch (e) {
      console.error('imageUpload → error procesando archivo:', e)
      return res.status(500).json({ error: 'Error procesando archivo' })
    }
  })
}

// ============= NUEVO: hasta 3 imágenes + 1 video =============
const _multerMedia = multer({
  storage: multer.memoryStorage(),
  // Límite duro por archivo: el más grande (video). Luego validamos imágenes aparte.
  limits: { files: 4, fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    const mm = (file.mimetype || '').toLowerCase()
    if (mm.startsWith('image/') || mm.startsWith('video/')) return cb(null, true)
    return cb(new Error('Solo imágenes o video (jpg/png/webp/bmp | mp4/webm/ogg).'))
  }
}).fields([
  { name: 'img', maxCount: 3 },   // enviar varias: -F "img=@foto1.jpg" -F "img=@foto2.png"
  { name: 'video', maxCount: 1 }  // -F "video=@clip.mp4"
])

export function mediaUpload () {
  return async (req, res, next) => {
    _multerMedia(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `Algún archivo supera el tamaño permitido (máx. video 15 MB).` })
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Exceso de archivos (máx. 3 imágenes + 1 video).' })
          }
          return res.status(400).json({ error: `Error de carga: ${err.message}` })
        }
        return res.status(415).json({ error: String(err.message || err) })
      }

      req.savedImages = []
      req.savedVideo = null
      req.savedAll = []
      req.fileName = null
      req.filePath = null

      try {
        // ---- Imágenes (0..3)
        const imgs = (req.files?.img || [])
        for (let i = 0; i < imgs.length; i++) {
          const f = imgs[i]
          if (!f?.buffer?.length) continue

          // Detectar mime real por buffer (no fiarse del mimetype del cliente)
          const ft = await fileTypeFromBuffer(f.buffer)
          const mime = (ft?.mime || '').toLowerCase()
          if (!ft || !ALLOWED_IMG.has(mime)) {
            return res.status(415).json({ error: `Imagen #${i + 1} con tipo no permitido.` })
          }
          if (f.size > MAX_IMAGE_BYTES) {
            return res.status(413).json({ error: `Imagen #${i + 1} supera ${Math.floor(MAX_IMAGE_BYTES/1024/1024)} MB` })
          }

          const saved = await saveBuffer(f.buffer, { originalName: f.originalname })
          req.savedImages.push(saved)
          req.savedAll.push({ ...saved, tipo: 'image', orden: i + 1 })

          // Compatibilidad: 1ra imagen como fileName/filePath
          if (i === 0) {
            req.fileName = saved.fileName
            req.filePath = saved.fullPath
          }
        }

        // ---- Video (0..1)
        const vid = (req.files?.video || [])[0]
        if (vid && vid.buffer?.length) {
          const ft = await fileTypeFromBuffer(vid.buffer)
          const mime = (ft?.mime || '').toLowerCase()
          if (!ft || !ALLOWED_VIDEO.has(mime)) {
            return res.status(415).json({ error: 'Formato de video no permitido (usa mp4/webm/ogg).' })
          }
          if (vid.size > MAX_VIDEO_BYTES) {
            return res.status(413).json({ error: 'El video supera 15 MB.' })
          }

          const saved = await saveBuffer(vid.buffer, { originalName: vid.originalname })
          req.savedVideo = saved
          req.savedAll.push({ ...saved, tipo: 'video', orden: 1 })
        }

        return next()
      } catch (e) {
        console.error('mediaUpload → error procesando archivos:', e)
        return res.status(500).json({ error: 'Error procesando archivos' })
      }
    })
  }
}
