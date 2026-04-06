// src/app.js
import dotenv from 'dotenv'
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import FormData from 'form-data'
import { armIdleGuard, disarmIdleGuard } from './idle-guard.js'
import { fileTypeFromFile } from 'file-type'

dotenv.config()

// ================== Límites y tipos ==================
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024) // 5 MB
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 15 * 1024 * 1024) // 15 MB
const ALLOWED_IMG = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp'])
const ALLOWED_VIDEO = new Set(['video/mp4', 'video/webm', 'video/ogg'])

function getFileSize(p) {
  try { return fs.statSync(p).size } catch { return 0 }
}

const PORT = process.env.PORT ?? 3501
const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://backend:3500').replace(/\/+$/, '')
const API_EMAIL_URL = (process.env.API_EMAIL_URL ?? API_BASE_URL).replace(/\/+$/, '')
const token = process.env.API_TOKEN
const wversion = process.env.WVERSION
const IDLE_MS = 600000

/**
 * ================== SESIONES EN MEMORIA ==================
 */
const userSessions = new Map()
function initializeSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      // registro
      nya: '',
      dni: '',
      telefono: '',
      email: '',
      registrado: false,
      // denuncia
      denuncia: {
        categoriaId: null,
        categoria: '',
        descripcion: '',
        ubicacion: '',
        localidadId: null,
        localidad: '',
        fechaHora: '',
        usuario: '',
        privado: 0,
        // NUEVO: adjuntos
        images: [],     // paths locales acumulados
        videoPath: null // path local único
      },
      // ✅ campos internos para adjuntos
      _enAdjuntos: false,
      _adjuntoFase: null, // null | 'si_no' | 'capturando'
      _adjTries: 0
    })
  }
}
function getSession(userId) {
  initializeSession(userId)
  return userSessions.get(userId)
}
function resetDenuncia(userId) {
  const s = getSession(userId)
  s.denuncia = {
    categoriaId: null,
    categoria: '',
    descripcion: '',
    ubicacion: '',
    localidadId: null,
    localidad: '',
    fechaHora: '',
    usuario: '',
    privado: 0,
    images: [],
    videoPath: null
  }
  s._descTries = 0
  s._ubicTries = 0
  s._adjuntoFase = null
  s._enAdjuntos = false
}

/** Fecha y hora actual para registrar al enviar la denuncia (Chaco, Argentina). */
function fechaHoraAlEnviar() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Cordoba',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

// ================== Helpers ==================
function ensureSession(ctx) {
  const s = getSession(ctx.from)
  if (!s.denuncia) s.denuncia = {}
  if (!Array.isArray(s._localidadesCache)) s._localidadesCache = []
  if (typeof s._locTries !== 'number') s._locTries = 0
  return s
}

async function safeGoto(gotoFlow, flow, fallback, logMsg) {
  try {
    if (!flow) throw new Error('Flow destino undefined')
    return await gotoFlow(flow)
  } catch (e) {
    console.error(logMsg || 'Error en gotoFlow', e?.message || e)
    return await gotoFlow(fallback)
  }
}

// --- Flow Despedida ---
const flowDespedida = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx) => disarmIdleGuard(ctx))
  .addAnswer('👋 ¡Gracias por contactarnos! Cuando quieras, volvemos a hablar. ¡Escribí *hola* para reiniciar!')

// ================== HELPERS API ==================
async function apiGuardarUsuario({ nya, dni, telefono, email }) {
  const url = `${API_BASE_URL}/usuarios`
  const payload = { nya, dni, telefono }

  // Solo mando email si viene con valor
  if (email) {
    payload.email = email
  }

  const { data } = await axios.post(url, payload, { headers: { Auth: token } })
  return data
}

async function apiListarCategorias() {
  const url = `${API_BASE_URL}/categorias`
  const { data } = await axios.get(url, { headers: { Auth: token } })
  return Array.isArray(data) ? data : (data?.categorias || [])
}

async function apiListarLocalidades() {
  const url = `${API_BASE_URL}/localidades`
  const { data } = await axios.get(url, { headers: { Auth: token } })
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.localidades)
      ? data.localidades
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.localidad)
          ? data.localidad
          : []
  const pick = (o, keys) => keys.find(k => o && o[k] != null)
  return arr.map((o, i) => {
    const idKey = pick(o, ['id', 'localidad_id', 'Id', 'ID'])
    const nameKey = pick(o, ['nombre', 'descripcion', 'descripción', 'titulo', 'título', 'localidad'])
    const id = idKey != null ? o[idKey] : (o?.id ?? i + 1)
    const nombre = nameKey != null ? String(o[nameKey]) : `Localidad ${i + 1}`
    return { id, nombre, _raw: o }
  })
}

/**
 * NUEVO: guarda denuncia con múltiples imágenes y opcional video
 * Campos multipart esperados por backend: img (0..3), video (0..1)
 */
async function apiGuardarDenuncia({
  descripcion,
  ubicacion,
  categoria,
  usuario,
  privado,
  localidad,
  fechaHora,
  imagePaths = [], // array de paths locales
  videoPath = null // path local o null
}) {
  const url = `${API_BASE_URL}/denuncias`
  const form = new FormData()

  // Campos de texto como strings
  form.append('descripcion', String(descripcion ?? ''))
  form.append('ubicacion', String(ubicacion ?? ''))
  form.append('categoria', String(categoria ?? ''))
  form.append('usuario', String(usuario ?? ''))
  form.append('privado', String(privado ?? ''))
  form.append('localidad', String(localidad ?? ''))
  if (fechaHora) form.append('fechaHora', String(fechaHora))

  // Adjuntar imágenes (0..3)
  for (const p of imagePaths.slice(0, 3)) {
    if (p && fs.existsSync(p)) {
      form.append('img', fs.createReadStream(p), path.basename(p))
    }
  }
  // Adjuntar video (0..1)
  if (videoPath && fs.existsSync(videoPath)) {
    form.append('video', fs.createReadStream(videoPath), path.basename(videoPath))
  }

  try {
    const { data } = await axios.post(url, form, {
      headers: { ...form.getHeaders(), Auth: token },
      maxBodyLength: Infinity,
      timeout: 30000
    })
    return data
  } catch (err) {
    if (err.response) {
      console.error('apiGuardarDenuncia → status:', err.response.status)
      console.error('apiGuardarDenuncia → body:', err.response.data)
    } else {
      console.error('apiGuardarDenuncia → error:', err.message)
    }
    throw err
  }
}

async function apiEnviarEmailResumen({ email, asunto, cuerpo }) {
  const url = `${API_EMAIL_URL}/email/enviar`
  const { data } = await axios.post(url, { to: email, subject: asunto, html: cuerpo })
  return data
}

// ================== VALIDACIONES ==================
/** Texto del usuario: NFKC (unifica dígitos “raros”), sin espacios invisibles. */
function normalizarNombreIngreso(v) {
  let t = String(v ?? '')
  try {
    t = t.normalize('NFKC')
  } catch {
    /* ignore */
  }
  return t.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
}

/**
 * Nombre y apellido: solo letras Unicode + marcas (acentos en NFD) y espacios.
 * Rechaza explícitamente cualquier categoría numérica \p{N} y el resto de símbolos.
 */
function validarNombreApellido(v) {
  const t = normalizarNombreIngreso(v)
  if (t.length < 3) return false
  if (/\p{N}/u.test(t)) return false
  if (/[^\p{L}\p{M}\s]/u.test(t)) return false
  return /^[\p{L}\p{M}]+(?:\s+[\p{L}\p{M}]+)*$/u.test(t)
}
function validarDNI(v) { return /^\d{7,9}$/.test((v || '').trim()) }
function validarEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim()) }

// ================== FLOWS ==================

// 1) Bienvenida
const flowBienvenida = addKeyword([EVENTS.WELCOME, 'hola', 'buenas', 'hi'])
  .addAction(async (ctx, { gotoFlow }) => { 
    const s = getSession(ctx.from)

    // Si alguien dice "hola", reiniciamos flags de adjuntos
    if (s) {
      s._enAdjuntos = false
      s._adjuntoFase = null
      s._adjWelcomeTries = 0
    }

    armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
  })
  .addAnswer(
    [
      '👋 ¡Bienvenido/a al canal de recepción de denuncias ambientales! - *ALERTA VERDE - JUSTICIA DE FALTAS - CHACO*',
      '⚠️ *IMPORTANTE*: Este canal NO es para emergencias inmediatas. En caso de urgencia (incendio activo, humo intenso, peligro para la vida o la propiedad), llamá al 911 o Bomberos. Atención de denuncias: lun-vie 07:00 a 13:00 hs.',
      'Para comenzar, vamos a registrarte.',
      '⚡ Podés reservar tus datos (denuncia *anónima*).',
      '-----------------------------------------------------------',
      '¿Deseás continuar con el *registro*? Responde *sí* o *no*.'
    ].join('\n'),
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      disarmIdleGuard(ctx)
      const s = getSession(ctx.from)
      const r = (ctx.body || '').trim().toLowerCase()
      if (['si', 'sí', 's', 'yes', 'y'].includes(r)) {
        s.intentosBienvenida = 0
        return gotoFlow(flowRegistroNombre)
      }
      if (['no', 'n'].includes(r)) {
        s.intentosBienvenida = 0
        return flowDynamic('Perfecto ✅. Cuando quieras continuar, escribí *registro*.')
      }
      s.intentosBienvenida = (s.intentosBienvenida ?? 0) + 1
      if (s.intentosBienvenida < 3) {
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return fallBack('Por favor respondé *sí* o *no*. Escribí *hola* para reiniciar.')
      }
      s.intentosBienvenida = 0
      return gotoFlow(flowDespedida)
    }
  )

// 2) Registro: Nombre y Apellido
const flowRegistroNombre = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('✍️ Indicá tu *Nombre y Apellido* (solo letras, sin números ni símbolos):', { capture: true }, async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
    disarmIdleGuard(ctx)
    const s = getSession(ctx.from)
    s.intentosnya = s.intentosnya ?? 0
    const nya = normalizarNombreIngreso(ctx.body)
    if (!nya || nya.length < 3) {
      s.intentosnya += 1
      if (s.intentosnya < 3) {
        return fallBack('El nombre ingresado es muy corto. Probá nuevamente con tu *Nombre y Apellido*.')
      }
      s.intentosnya = 0
      return gotoFlow(flowDespedida)
    }
    if (!validarNombreApellido(nya)) {
      s.intentosnya += 1
      if (s.intentosnya < 3) {
        return fallBack('El nombre solo puede tener *letras* y espacios (sin números ni símbolos). Ej.: *María Pérez*.')
      }
      s.intentosnya = 0
      return gotoFlow(flowDespedida)
    }
    s.intentosnya = 0
    s.nya = nya
    return gotoFlow(flowRegistroDNI)
  })

// 3) Registro: DNI
const flowRegistroDNI = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('🪪 Ingresá tu *DNI* (solo números):', { capture: true, idle: 15000, idleFallback: flowDespedida }, async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
    disarmIdleGuard(ctx)
    const s = getSession(ctx.from)
    s.intentosdni = s.intentosdni ?? 0
    const dni = (ctx.body || '').replace(/\D/g, '')
    if (!validarDNI(dni)) {
      s.intentosdni += 1
      if (s.intentosdni < 3) {
        return fallBack('El DNI no parece válido. Ingresá solo números (7 a 9 dígitos).')
      }
      s.intentosdni = 0
      return gotoFlow(flowDespedida)
    }
    s.intentosdni = 0
    s.dni = dni
    return gotoFlow(flowRegistroEmail)
  })

// 4) Registro: Email (opcional)
const flowRegistroEmail = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { 
    armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) 
  })
  .addAnswer(
    '📧 Ingresá tu *email* (o escribí *no* si no tenés o no querés informarlo):',
    { capture: true, idle: 15000, idleFallback: flowDespedida },
    async (ctx, { fallBack, gotoFlow, flowDynamic }) => {
      disarmIdleGuard(ctx)
      const s = getSession(ctx.from)
      s.intentosemail = s.intentosemail ?? 0

      const raw = (ctx.body || '').trim()
      const lower = raw.toLowerCase()
      console.log()
      // 👉 Caso: el usuario decide NO informar email
      if (['omitir', 'no', 'n'].includes(lower)) {
        s.intentosemail = 0
        s.email = ''
        s.telefono = ctx.from

        try {
          await apiGuardarUsuario({
            nya: s.nya,
            dni: s.dni,
            telefono: s.telefono,
            email: null
          })
          s.registrado = true
          await flowDynamic('✅ *Registro completado* correctamente (sin email informado).')
        } catch (err) {
          console.error('Error guardando usuario (sin email):', err?.response?.data || err.message)
          // 👇 Seguimos igual al flujo de denuncia aunque falle el guardado
          await flowDynamic('⚠️ No pude guardar tus datos, pero vamos a continuar con la denuncia.')
        }

        await new Promise(r => setTimeout(r, 800))
        await flowDynamic('✅ Ahora vamos a registrar la denuncia.')
        return gotoFlow(flowDenunciaCategoria)
      }

      // 👉 Caso: intenta informar un email
      const email = lower
      if (!validarEmail(email)) {
        s.intentosemail += 1
        if (s.intentosemail < 3) {
          return fallBack('El email no parece válido. Intentá nuevamente (ej.: nombre@dominio.com) o escribí *omitir*.')
        }
        s.intentosemail = 0
        return gotoFlow(flowDespedida)
      }

      // Email válido
      s.intentosemail = 0
      s.email = email
      s.telefono = ctx.from

      try {
        await apiGuardarUsuario({ 
          nya: s.nya, 
          dni: s.dni, 
          telefono: s.telefono, 
          email: s.email 
        })
        s.registrado = true
        await flowDynamic('✅ *Registro completado* correctamente.')
      } catch (err) {
        console.error('Error guardando usuario:', err?.response?.data || err.message)
        await flowDynamic('⚠️ No pude guardar tus datos, pero vamos a continuar con la denuncia.')
      }

      await new Promise(r => setTimeout(r, 800))
      await flowDynamic('✅ Ahora vamos a registrar la denuncia.')
      return gotoFlow(flowDenunciaCategoria)
    }
  )


/**
 * =============== Flujo de DENUNCIA ===============
 */
const flowDenunciaCategoria = addKeyword(EVENTS.ACTION)
  .addAnswer(async () => '📝 *Nueva Denuncia*\nBuscando categorías...', { capture: false },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const s = getSession(ctx.from)
      resetDenuncia(ctx.from)
      try {
        const categorias = await apiListarCategorias()
        if (!categorias.length) {
          await flowDynamic('⚠️ No hay categorías disponibles en este momento.')
          return gotoFlow(flowDespedida)
        }
        s._categoriasCache = categorias
        const listado = categorias.map((c, i) => `${i + 1}) ${c.descripcion}`).join('\n')
        await flowDynamic(['Elegí una *categoría* (escribe el número exacto):', listado].join('\n'))
        return gotoFlow(flowDenunciaCategoriaElegida)
      } catch (e) {
        console.error('Error listando categorías:', e?.response?.data || e.message)
        await flowDynamic('⚠️ Ocurrió un error al obtener las categorías. Intentá más tarde.')
        return gotoFlow(flowDespedida)
      }
    }
  )

const flowDenunciaCategoriaElegida = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('Escribí el *número* exacto de la categoría:', { capture: true },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      disarmIdleGuard(ctx)
      const s = getSession(ctx.from)
      if (typeof s._catTries !== 'number') s._catTries = 0
      const categorias = s._categoriasCache || []
      if (!categorias.length) {
        await flowDynamic('⚠️ No tengo el listado en memoria. Volvemos a empezar.')
        return gotoFlow(flowDenunciaCategoria)
      }
      const r = (ctx.body || '').trim()
      const n = Number(r)
      let elegida = null
      if (!Number.isNaN(n) && n >= 1 && n <= categorias.length) elegida = categorias[n - 1]
      if (!elegida) elegida = categorias.find(c => String(c.id) === r)

      if (!elegida) {
        s._catTries += 1
        if (s._catTries >= 3) {
          s._catTries = 0
          delete s._categoriasCache
          await flowDynamic('🙇 Dejémoslo acá por ahora. Escribí *hola* para reiniciar.')
          return gotoFlow(flowDespedida)
        }
        const restantes = 3 - s._catTries
        const listado = categorias.map((c, i) => `${i + 1}) ${c.descripcion}`).join('\n')
        const msg = ['❗ *Entrada inválida.*', `Te ${restantes === 1 ? 'queda *1* oportunidad' : `quedan *${restantes}* oportunidades`} más:`, listado].join('\n')
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return fallBack(msg)
      }

      s._catTries = 0
      delete s._categoriasCache
      s.denuncia.categoriaId = elegida.id
      s.denuncia.categoria = elegida.descripcion
      await flowDynamic(`✅ Categoría seleccionada: *${elegida.descripcion}*`)
      return gotoFlow(flowDenunciaDescripcion)
    }
  )

const flowDenunciaDescripcion = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('✍️ Describe brevemente lo ocurrido, indicando de ser posible el tipo de hecho, fecha y hora:', { capture: true }, async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
    disarmIdleGuard(ctx)
    const s = getSession(ctx.from)
    if (typeof s._descTries !== 'number') s._descTries = 0
    const desc = (ctx.body || '').trim()
    if (!desc || desc.length < 5) {
      s._descTries += 1
      if (s._descTries < 3) {
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return fallBack('La descripción es muy corta. Contanos un poco más, por favor.')
      }
      s._descTries = 0
      return gotoFlow(flowDespedida)
    }
    s._descTries = 0
    s.denuncia.descripcion = desc
    return gotoFlow(flowDenunciaUbicacion)
  })

const flowDenunciaUbicacion = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('📍 Indicá la *ubicación* (calle, altura, referencias):', { capture: true, idle: 15000, idleFallback: flowDespedida },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      disarmIdleGuard(ctx)
      const s = getSession(ctx.from)
      if (typeof s._ubicTries !== 'number') s._ubicTries = 0
      const ubic = (ctx.body || '').trim()
      if (!ubic || ubic.length < 3) {
        s._ubicTries += 1
        if (s._ubicTries < 3) {
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return fallBack('La ubicación es muy corta. Probá nuevamente.')
        }
        s._ubicTries = 0
        return gotoFlow(flowDespedida)
      }
      s._ubicTries = 0
      s.denuncia.ubicacion = ubic
      return gotoFlow(flowDenunciaLocalidad)
    }
  )

// Localidades
const flowDenunciaLocalidad = addKeyword(EVENTS.ACTION)
  .addAnswer(async () => '🏙️ Buscando *localidades*...', { capture: false },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const s = ensureSession(ctx)
      try {
        const localidades = await apiListarLocalidades()
        if (!localidades.length) {
          await flowDynamic('⚠️ No hay localidades disponibles en este momento.')
          return safeGoto(gotoFlow, flowDespedida, flowDespedida, 'No hay localidades')
        }
        s._localidadesCache = localidades
        s._locTries = 0
        const toShow = localidades.slice(0, 20)
        const listado = toShow.map((l, i) => `${i + 1}) ${l.nombre}`).join('\n')
        await flowDynamic([
          'Elegí una *localidad* (escribí el *número* exacto de la lista):',
          listado,
          localidades.length > 20 ? `\n(Se muestran 20 de ${localidades.length}. Podés escribir el *ID* exacto si no está en la lista.)` : ''
        ].join('\n'))
        return safeGoto(gotoFlow, flowDenunciaLocalidadElegida, flowDespedida, 'Ir a Elegida')
      } catch (e) {
        console.error('Error listando localidades:', e?.response?.data || e.message)
        await flowDynamic('⚠️ Ocurrió un error al obtener las localidades. Intentá más tarde.')
        return safeGoto(gotoFlow, flowDespedida, flowDespedida, 'Error listando localidades')
      }
    }
  )

const flowDenunciaLocalidadElegida = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('Escribí el *número* exacto de la localidad:', { capture: true },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      disarmIdleGuard(ctx)
      try {
        const s = ensureSession(ctx)
        const localidades = s._localidadesCache || []
        if (!localidades.length) {
          await flowDynamic('⚠️ No tengo el listado en memoria. Volvemos a empezar.')
          return safeGoto(gotoFlow, flowDenunciaLocalidad, flowDespedida, 'Cache vacío')
        }
        const raw = (ctx.body || '').trim()
        const onlyDigits = raw.replace(/[^\d]/g, '')
        const n = Number(onlyDigits)
        let elegida = null
        if (!Number.isNaN(n) && n >= 1 && n <= Math.min(20, localidades.length)) elegida = localidades[n - 1]
        if (!elegida) elegida = localidades.find(l => String(l.id) === raw)
        if (!elegida) {
          s._locTries += 1
          if (s._locTries >= 3) {
            s._locTries = 0
            delete s._localidadesCache
            await flowDynamic('🙇 Dejémoslo acá por ahora. Escribí *hola* para reiniciar.')
            return safeGoto(gotoFlow, flowDespedida, flowDespedida, 'Max reintentos')
          }
          const restantes = 3 - s._locTries
          const toShow = localidades.slice(0, 20)
          const listado = toShow.map((l, i) => `${i + 1}) ${l.nombre}`).join('\n')
          const msg = [
            '❗ *Entrada inválida.*',
            `Te ${restantes === 1 ? 'queda *1* oportunidad' : `quedan *${restantes}* oportunidades`} más.`,
            'Elegí el *número* exacto:',
            listado,
            localidades.length > 20 ? `\n(Se muestran 20 de ${localidades.length}...)` : ''
          ].join('\n')
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return fallBack(msg)
        }
        s.denuncia.localidadId = elegida.id
        s.denuncia.localidad = elegida.nombre
        s._locTries = 0
        delete s._localidadesCache
        await flowDynamic(`✅ Localidad seleccionada: *${elegida.nombre}*`)
        return safeGoto(gotoFlow, flowAdjuntoPregunta, flowDespedida, 'Ir a adjuntos')
      } catch (err) {
        console.error('Error en selección de localidad:', err?.message || err)
        await flowDynamic('⚠️ Hubo un problema procesando tu elección.')
        return safeGoto(gotoFlow, flowDespedida, flowDespedida, 'Catch selección localidad')
      }
    }
  )

/** Tras responder *Sí* a archivos: instrucciones y recepción de medios. */
const flowAdjuntoInstrucciones = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => {
    armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
    const s = getSession(ctx.from)
    s._adjuntoFase = 'capturando'
    s._enAdjuntos = true
  })
  .addAnswer(
    [
      '📎 Podés adjuntar *hasta 3 archivos* de imagen (JPG/PNG/WEBP/BMP, máx. 5 MB c/u).',
      'También podés enviar *1 video* (MP4/WEBM/OGG, máx. 15 MB).',
      '',
      'Envialos *ahora* en este chat.',
      '🟢 Cuando termines, escribí *ok*, *listo* o *enviar*.',
      '✋ Si no querés adjuntar nada, escribí *omitir*.'
    ].join('\n'),
    { capture: false }
  )

const flowAdjuntoPregunta = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { gotoFlow }) => {
    armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
    const s = getSession(ctx.from)
    s._adjuntoFase = 'si_no'
    s._enAdjuntos = false
  })
  .addAnswer(
    '¿Deseás agregar *archivos* (imágenes o video)? Respondé *Sí* o *No*.',
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      disarmIdleGuard(ctx)
      const s = getSession(ctx.from)
      const r = (ctx.body || '').trim().toLowerCase()
      if (['si', 'sí', 's', 'yes', 'y'].includes(r)) {
        return gotoFlow(flowAdjuntoInstrucciones)
      }
      if (['no', 'n'].includes(r)) {
        s._adjuntoFase = null
        s._enAdjuntos = false
        await flowDynamic('✅ Continuamos *sin adjuntos*.')
        return gotoFlow(flowEstablecePrivado)
      }
      armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
      return fallBack('Respondé *Sí* si querés adjuntar archivos, o *No* para seguir sin ellos.')
    }
  )

const flowAdjuntosComandos = addKeyword(['listo', 'ok', 'enviar', 'siguiente', 'omitir'])
  .addAction(async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    if (!s || s._adjuntoFase !== 'capturando') {
      return
    }

    const raw = (ctx.body || '').trim().toLowerCase()
    console.log('💬 flowAdjuntosComandos recibió:', raw, 'para usuario', ctx.from)

    if (raw === 'omitir') {
      s._enAdjuntos = false
      s._adjuntoFase = null
      await flowDynamic('✅ Continuamos *sin adjuntos*.')
      return gotoFlow(flowEstablecePrivado)
    }

    if (raw === 'listo' || raw === 'ok' || raw === 'enviar' || raw === 'siguiente') {
      s._enAdjuntos = false
      s._adjuntoFase = null
      return gotoFlow(flowEstablecePrivado)
    }

    await flowDynamic([
      '❗ *Mensaje no válido en la etapa de adjuntos.*',
      '',
      'En este paso podés:',
      '• Enviar *fotos* (hasta 3) y/o *1 video*; o',
      '• Escribir *ok*, *listo* o *enviar* para continuar; o',
      '• Escribir *omitir* para seguir sin adjuntos.',
      '',
      'Probá nuevamente enviando el archivo o escribí *ok* / *listo* / *enviar* / *omitir*.'
    ].join('\n'))
  })

const flowAdjuntoMedia = addKeyword([EVENTS.MEDIA])
  .addAction(async (ctx, { provider, flowDynamic, gotoFlow }) => {
    disarmIdleGuard(ctx)
    const s = getSession(ctx.from)
    if (!s || !s.denuncia) return
    if (s._adjuntoFase !== 'capturando') return
    try {
      const localDir = path.resolve('./uploads_tmp')
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true })

      const localPath = await provider.saveFile(ctx, { path: localDir })
      if (!localPath || !fs.existsSync(localPath)) {
        await flowDynamic('❌ No pude guardar el archivo. ¿Podés reenviarlo?')
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return
      }

      const size = getFileSize(localPath)
      const ft = await fileTypeFromFile(localPath)
      const mime = (ft?.mime || '').toLowerCase()

      // Clasificar por MIME real
      const isImage = ALLOWED_IMG.has(mime)
      const isVideo = ALLOWED_VIDEO.has(mime)

      if (!isImage && !isVideo) {
        try { fs.unlinkSync(localPath) } catch {}
        await flowDynamic('❌ Formato no permitido. Fotos: JPG/PNG/WEBP/BMP. Video: MP4/WEBM/OGG.')
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return
      }

      if (isImage) {
        if (size > MAX_IMAGE_BYTES) {
          try { fs.unlinkSync(localPath) } catch {}
          await flowDynamic(`❌ La imagen pesa ${(size/1024/1024).toFixed(1)} MB (máx ${Math.floor(MAX_IMAGE_BYTES/1024/1024)} MB).`)
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return
        }
        if (s.denuncia.images.length >= 3) {
          try { fs.unlinkSync(localPath) } catch {}
          await flowDynamic('ℹ️ Ya tenés 3 imágenes. Escribí *ok*, *listo* o *enviar* para continuar, o *omitir*.')
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return
        }
        s.denuncia.images.push(path.resolve(localPath))
        await flowDynamic(`✅ Imagen agregada (${s.denuncia.images.length}/3). Enviá otra, un video, o escribí *ok* / *listo* / *enviar* / *omitir*.`)
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return
      }

      if (isVideo) {
        if (size > MAX_VIDEO_BYTES) {
          try { fs.unlinkSync(localPath) } catch {}
          await flowDynamic(`❌ El video pesa ${(size/1024/1024).toFixed(1)} MB (máx 15 MB).`)
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return
        }
        if (s.denuncia.videoPath) {
          try { fs.unlinkSync(localPath) } catch {}
          await flowDynamic('ℹ️ Ya cargaste 1 video. Solo se permite uno. Enviá imágenes o *ok* / *listo* / *enviar*.')
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return
        }
        s.denuncia.videoPath = path.resolve(localPath)
        await flowDynamic('✅ Video agregado (1/1). Podés enviar imágenes (hasta 3) o escribir *ok* / *listo* / *enviar*.')
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return
      }
    } catch (e) {
      console.error('Error guardando/validando media:', e)
      await flowDynamic('⚠️ Hubo un problema al procesar el archivo. Reintentá o escribí *omitir*.')
      armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
    }
  })

const flowEstablecePrivado = addKeyword(EVENTS.ACTION)
  .addAnswer(
    '🔒 ¿Deseás *reservar tus datos personales*? Respondé *Sí*/*No*',
    { capture: true, idle: 15000, idleFallback: flowDespedida },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      const s = getSession(ctx.from)
      s.denuncia = s.denuncia || {}
      s._enAdjuntos = false
      s._adjuntoFase = null
      const conf = (ctx.body || '').trim().toLowerCase()
      if (['si', 'sí', 's', 'yes', 'y'].includes(conf)) {
        s._privTries = 0
        s.denuncia.privado = 1
        await flowDynamic('Tus datos se reservarán ✅')
      } else if (['no', 'n'].includes(conf)) {
        s._privTries = 0
        s.denuncia.privado = 0
        await flowDynamic('Tus datos *no* se reservarán ✅')
      } else {
        s._privTries = (s._privTries ?? 0) + 1
        if (s._privTries < 3) {
          return fallBack('Por favor respondé *Sí* o *No*.')
        }
        s._privTries = 0
        return gotoFlow(flowDespedida)
      }
      return gotoFlow(flowDenunciaConfirmacion)
    }
  )

const flowDenunciaConfirmacion = addKeyword(EVENTS.ACTION)
  .addAction(async (ctx, { flowDynamic }) => {
    const s = getSession(ctx.from)
    s.denuncia = s.denuncia || {}
    const resumen = [
      '📄 *Confirmá tu denuncia*',
      `• Categoría: ${s.denuncia.categoria ?? s.denuncia.categoriaId ?? '-'}`,
      `• Descripción: ${s.denuncia.descripcion ?? '-'}`,
      `• Ubicación: ${s.denuncia.ubicacion ?? '-'}`,
      `• Localidad: ${s.denuncia.localidad ?? '-'}`,
      '• Fecha/Hora: al confirmar el envío se registrará la fecha y hora en que enviás la denuncia',
      `• Datos reservados: ${s.denuncia.privado ? 'Sí' : 'No'}`,
      `• Adjuntos: ${s.denuncia.images.length} imágenes, ${s.denuncia.videoPath ? '1' : '0'} video`
    ].join('\n')
    await flowDynamic(resumen)
  })
  .addAction(async (ctx, { flowDynamic, gotoFlow }) => { armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS) })
  .addAnswer('¿Deseás *enviar* la denuncia? Respondé *sí* o *no*.', { capture: true },
    async (ctx, { gotoFlow, flowDynamic, fallBack }) => {
      disarmIdleGuard(ctx)
      const s = getSession(ctx.from)
      const r = (ctx.body || '').trim().toLowerCase()

      if (['si', 'sí', 's', 'yes', 'y'].includes(r)) {
        s._confTries = 0
        try {
          const fechaHora = fechaHoraAlEnviar()
          s.denuncia.fechaHora = fechaHora
          const denRes = await apiGuardarDenuncia({
            usuario: s.dni,
            categoria: s.denuncia.categoriaId,
            descripcion: s.denuncia.descripcion,
            ubicacion: s.denuncia.ubicacion,
            localidad: s.denuncia.localidadId,
            fechaHora,
            privado: s.denuncia.privado,
            imagePaths: s.denuncia.images,
            videoPath: s.denuncia.videoPath
          })

          // Limpieza de temporales (best-effort)
          for (const p of s.denuncia.images) { try { fs.unlinkSync(p) } catch {} }
          if (s.denuncia.videoPath) { try { fs.unlinkSync(s.denuncia.videoPath) } catch {} }

          await new Promise(r => setTimeout(r, 1200))
          await flowDynamic('✅ *Denuncia enviada*. Se notificó al Juzgado y se envió copia a tu correo.')
          resetDenuncia(ctx.from)
          return gotoFlow(flowDespedida)
        } catch (err) {
          console.error('Error procesando denuncia:', err?.response?.data || err.message)
          armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
          return fallBack('⚠️ Ocurrió un error al enviar la denuncia. Intentá de nuevo respondiendo *sí* o *no*.')
        }
      }

      if (['no', 'n'].includes(r)) {
        s._confTries = 0
        // Limpieza si quedó algo pendiente
        for (const p of s.denuncia.images || []) { try { fs.unlinkSync(p) } catch {} }
        if (s.denuncia.videoPath) { try { fs.unlinkSync(s.denuncia.videoPath) } catch {} }
        resetDenuncia(ctx.from)
        await flowDynamic('Operación cancelada. No se envió la denuncia.')
        return gotoFlow(flowBienvenida)
      }

      s._confTries = (s._confTries ?? 0) + 1
      if (s._confTries < 3) {
        armIdleGuard(ctx, gotoFlow, flowDespedida, IDLE_MS)
        return fallBack('Por favor respondé *sí* o *no*.')
      }
      s._confTries = 0
      return gotoFlow(flowDespedida)
    }
  )

/**
 * ================== BOOTSTRAP DEL BOT ==================
 */
const main = async () => {
  const adapterFlow = createFlow([
    // 🟢 Primero el manejo de adjuntos SIEMPRE
    flowAdjuntoMedia,
    flowAdjuntosComandos,
    flowAdjuntoInstrucciones,
    flowAdjuntoPregunta,

    // 🟡 Luego ya los flows normales
    flowEstablecePrivado,
    flowDenunciaConfirmacion,

    // 🟠 Flujos de denuncia
    flowDenunciaLocalidadElegida,
    flowDenunciaLocalidad,
    flowDenunciaUbicacion,
    flowDenunciaDescripcion,
    flowDenunciaCategoriaElegida,
    flowDenunciaCategoria,

    // 🟣 Flujos de registro
    flowRegistroEmail,
    flowRegistroDNI,
    flowRegistroNombre,

    // 🔴 Por último bienvenida
    flowBienvenida,
    flowDespedida
])

  const adapterProvider = createProvider(Provider, {version: [2,3000,wversion]})
  const adapterDB = new Database()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB
  })

  httpServer(+PORT)
}

main()
