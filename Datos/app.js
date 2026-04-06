// app.js
import 'dotenv/config'
import axios from 'axios'
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS
} from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import QRPortal from '@bot-whatsapp/portal'

/**
 * ================== CONFIG ==================
 */
const PORT = process.env.PORT ?? 3008
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:8080'
const API_EMAIL_URL = process.env.API_EMAIL_URL ?? API_BASE_URL
const WA_NUMBER = (process.env.WA_NUMBER || '').replace(/[^\d]/g, '') // ej: 5493624XXXXXX

/**
 * ================== SESIONES EN MEMORIA ==================
 */
const userSessions = new Map()
function initializeSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      // registro
      nombre: '',
      dni: '',
      telefono: '',
      email: '',
      registrado: false,
      // denuncia
      denuncia: {
        categoria: '',
        descripcion: '',
        ubicacion: '',
        localidad: '',
        fechaHora: ''
      }
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
    categoria: '',
    descripcion: '',
    ubicacion: '',
    localidad: '',
    fechaHora: ''
  }
}

/**
 * ================== HELPERS API ==================
 */
async function apiGuardarUsuario({ nombre, dni, telefono, email }) {
  const url = `${API_BASE_URL}/usuarios/registrar`
  const { data } = await axios.post(url, { nombre, dni, telefono, email })
  return data
}
async function apiGuardarDenuncia({ dni, categoria, descripcion, ubicacion, localidad, fechaHora }) {
  const url = `${API_BASE_URL}/denuncias/crear`
  const { data } = await axios.post(url, {
    dni,
    categoria,
    descripcion,
    ubicacion,
    localidad,
    fechaHora
  })
  return data
}
async function apiEnviarEmailResumen({ email, asunto, cuerpo }) {
  const url = `${API_EMAIL_URL}/email/enviar`
  const { data } = await axios.post(url, { to: email, subject: asunto, html: cuerpo })
  return data
}

/**
 * ================== VALIDACIONES SENCILLAS ==================
 */
function validarDNI(v) {
  return /^\d{7,9}$/.test((v || '').trim())
}
function validarTelefono(v) {
  return /^[+\d][\d\s-]{7,16}$/.test((v || '').trim())
}
function validarEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim())
}

/**
 * ================== FLOWS ==================
 */

// 1) Bienvenida
const flowBienvenida = addKeyword([EVENTS.WELCOME, 'hola', 'buenas', 'hi'])
  .addAnswer(
    [
      '👋 ¡Bienvenido/a al asistente del Poder Judicial!',
      'Para comenzar, vamos a registrarte.',
      '¿Deseás continuar con el *registro*? Responde *sí* o *no*.'
    ].join('\n'),
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const r = (ctx.body || '').trim().toLowerCase()
      if (['si', 'sí', 's', 'yes', 'y'].includes(r)) {
        return gotoFlow(flowRegistroNombre)
      } else if (['no', 'n'].includes(r)) {
        return await flowDynamic('Perfecto ✅. Cuando quieras continuar, escribe *registro*.')
      } else {
        return await flowDynamic('Por favor responde *sí* o *no*. Escribe *hola* para reiniciar.')
      }
    }
  )

// 2) Registro: Nombre y Apellido
const flowRegistroNombre = addKeyword(EVENTS.ACTION)
  .addAnswer('✍️ Indicá tu *Nombre y Apellido*:', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const nombre = (ctx.body || '').trim()
    if (!nombre || nombre.length < 3) {
      return await flowDynamic('El nombre ingresado es muy corto. Probá nuevamente con tu *Nombre y Apellido*.')
    }
    s.nombre = nombre
    return gotoFlow(flowRegistroDNI)
  })

// 3) Registro: DNI
const flowRegistroDNI = addKeyword(EVENTS.ACTION)
  .addAnswer('🪪 Ingresá tu *DNI* (solo números):', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const dni = (ctx.body || '').replace(/\D/g, '')
    if (!validarDNI(dni)) {
      return await flowDynamic('El DNI no parece válido. Ingresá solo números (7 a 9 dígitos).')
    }
    s.dni = dni
    return gotoFlow(flowRegistroTelefono)
  })

// 4) Registro: Teléfono
const flowRegistroTelefono = addKeyword(EVENTS.ACTION)
  .addAnswer('📱 Ingresá tu *teléfono* (podés incluir código de país, ej: +54 362...):', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const tel = (ctx.body || '').trim()
    if (!validarTelefono(tel)) {
      return await flowDynamic('El teléfono no parece válido. Intentá nuevamente (ej.: +54 362 400-0000).')
    }
    s.telefono = tel
    return gotoFlow(flowRegistroEmail)
  })

// 5) Registro: Email
const flowRegistroEmail = addKeyword(EVENTS.ACTION)
  .addAnswer('📧 Ingresá tu *email*:', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const email = (ctx.body || '').trim().toLowerCase()
    if (!validarEmail(email)) {
      return await flowDynamic('El email no parece válido. Intentá nuevamente (ej.: nombre@dominio.com).')
    }
    s.email = email

    try {
      await apiGuardarUsuario({
        nombre: s.nombre,
        dni: s.dni,
        telefono: s.telefono,
        email: s.email
      })
      s.registrado = true
      await flowDynamic('✅ *Registro completado* correctamente.')
      return gotoFlow(flowMenuPrincipal)
    } catch (err) {
      console.error('Error guardando usuario:', err?.response?.data || err.message)
      await flowDynamic('⚠️ Ocurrió un error al guardar tus datos. Intentá más tarde o escribe *registro* para reintentar.')
    }
  })

// 6) Menú principal
const flowMenuPrincipal = addKeyword(['menu', 'registro'])
  .addAnswer(
    [
      '*Menú Principal*',
      'Escribe el número de la opción:',
      '1️⃣ Registrar *Denuncia*',
      '2️⃣ Ver *Mis datos*',
      '3️⃣ *Salir*'
    ].join('\n'),
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const s = getSession(ctx.from)
      const r = (ctx.body || '').trim()
      if (!s.registrado) {
        return gotoFlow(flowBienvenida)
      }
      if (r === '1') return gotoFlow(flowDenunciaCategoria)
      if (r === '2') {
        await flowDynamic(
          [
            '👤 *Tus datos*',
            `• Nombre: ${s.nombre}`,
            `• DNI: ${s.dni}`,
            `• Teléfono: ${s.telefono}`,
            `• Email: ${s.email}`
          ].join('\n')
        )
        return gotoFlow(flowMenuPrincipal)
      }
      if (r === '3') {
        return await flowDynamic('👋 ¡Gracias por usar el asistente! Escribe *hola* si necesitás algo más.')
      }
      return await flowDynamic('Elige 1, 2 o 3.')
    }
  )

/**
 * =============== Flujo de DENUNCIA ===============
 */
const flowDenunciaCategoria = addKeyword(EVENTS.ACTION)
  .addAnswer(
    [
      '📝 *Nueva Denuncia*',
      'Elegí una *categoría* (escribe el número):',
      '1) Quema de pasto',
      '2) Maltrato animal',
      '3) Ruidos molestos',
      '4) Basurales / Residuos',
      '5) Otra'
    ].join('\n'),
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const s = getSession(ctx.from)
      resetDenuncia(ctx.from)
      const r = (ctx.body || '').trim()
      const mapa = {
        '1': 'Quema de pasto',
        '2': 'Maltrato animal',
        '3': 'Ruidos molestos',
        '4': 'Basurales / Residuos',
        '5': 'Otra'
      }
      const cat = mapa[r]
      if (!cat) return await flowDynamic('Elegí una opción válida (1 a 5).')
      s.denuncia.categoria = cat
      return gotoFlow(flowDenunciaDescripcion)
    }
  )

const flowDenunciaDescripcion = addKeyword(EVENTS.ACTION)
  .addAnswer('✍️ Describí brevemente lo ocurrido:', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const desc = (ctx.body || '').trim()
    if (!desc || desc.length < 5) {
      return await flowDynamic('La descripción es muy corta. Contanos un poco más, por favor.')
    }
    s.denuncia.descripcion = desc
    return gotoFlow(flowDenunciaUbicacion)
  })

const flowDenunciaUbicacion = addKeyword(EVENTS.ACTION)
  .addAnswer('📍 Indicá la *ubicación* (calle, altura, referencias):', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const ubic = (ctx.body || '').trim()
    if (!ubic || ubic.length < 3) {
      return await flowDynamic('La ubicación es muy corta. Probá nuevamente.')
    }
    s.denuncia.ubicacion = ubic
    return gotoFlow(flowDenunciaLocalidad)
  })

const flowDenunciaLocalidad = addKeyword(EVENTS.ACTION)
  .addAnswer('🏙️ Indicá la *localidad*:', { capture: true }, async (ctx, { gotoFlow, flowDynamic }) => {
    const s = getSession(ctx.from)
    const loc = (ctx.body || '').trim()
    if (!loc || loc.length < 3) {
      return await flowDynamic('La localidad es muy corta. Probá nuevamente.')
    }
    s.denuncia.localidad = loc
    return gotoFlow(flowDenunciaFechaHora)
  })

const flowDenunciaFechaHora = addKeyword(EVENTS.ACTION)
  .addAnswer(
    '🕒 Indicá *fecha y hora* del hecho (ej.: 11/09/2025 14:30):',
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const s = getSession(ctx.from)
      const fh = (ctx.body || '').trim()
      if (!fh || fh.length < 5) {
        return await flowDynamic('Fecha y hora inválidas. Probá nuevamente (ej.: 11/09/2025 14:30).')
      }
      s.denuncia.fechaHora = fh
      return gotoFlow(flowDenunciaConfirmacion)
    }
  )

const flowDenunciaConfirmacion = addKeyword(EVENTS.ACTION)
  .addAnswer(
    async (ctx) => {
      const s = getSession(ctx.from)
      return [
        '📄 *Confirmá tu denuncia*',
        `• Categoría: ${s.denuncia.categoria}`,
        `• Descripción: ${s.denuncia.descripcion}`,
        `• Ubicación: ${s.denuncia.ubicacion}`,
        `• Localidad: ${s.denuncia.localidad}`,
        `• Fecha/Hora: ${s.denuncia.fechaHora}`,
        '',
        '¿Deseás *enviar* la denuncia? Responde *sí* o *no*.'
      ].join('\n')
    },
    { capture: true },
    async (ctx, { gotoFlow, flowDynamic }) => {
      const s = getSession(ctx.from)
      const r = (ctx.body || '').trim().toLowerCase()
      if (['si', 'sí', 's', 'yes', 'y'].includes(r)) {
        try {
          const denRes = await apiGuardarDenuncia({
            dni: s.dni,
            categoria: s.denuncia.categoria,
            descripcion: s.denuncia.descripcion,
            ubicacion: s.denuncia.ubicacion,
            localidad: s.denuncia.localidad,
            fechaHora: s.denuncia.fechaHora
          })

          const asunto = 'Confirmación de Denuncia'
          const cuerpo = `
            <h2>Denuncia registrada</h2>
            <p><strong>Denunciante:</strong> ${s.nombre} (DNI ${s.dni})</p>
            <ul>
              <li><strong>Categoría:</strong> ${s.denuncia.categoria}</li>
              <li><strong>Descripción:</strong> ${s.denuncia.descripcion}</li>
              <li><strong>Ubicación:</strong> ${s.denuncia.ubicacion}</li>
              <li><strong>Localidad:</strong> ${s.denuncia.localidad}</li>
              <li><strong>Fecha/Hora:</strong> ${s.denuncia.fechaHora}</li>
            </ul>
            ${denRes?.numero ? `<p><strong>Número de denuncia:</strong> ${denRes.numero}</p>` : ''}
            <p>Gracias por utilizar el asistente.</p>
          `
          await apiEnviarEmailResumen({ email: s.email, asunto, cuerpo })

          await flowDynamic('✅ *Denuncia enviada* y confirmación enviada a tu email.')
          resetDenuncia(ctx.from)
          return gotoFlow(flowMenuPrincipal)
        } catch (err) {
          console.error('Error procesando denuncia:', err?.response?.data || err.message)
          return await flowDynamic('⚠️ Ocurrió un error al enviar la denuncia. Intentá nuevamente más tarde.')
        }
      } else if (['no', 'n'].includes(r)) {
        resetDenuncia(ctx.from)
        await flowDynamic('Operación cancelada. No se envió la denuncia.')
        return gotoFlow(flowMenuPrincipal)
      } else {
        return await flowDynamic('Por favor respondé *sí* o *no*.')
      }
    }
  )

/**
 * ================== BOOTSTRAP DEL BOT ==================
 */
const main = async () => {
  const adapterDB = new Database()

  // ID único para evitar sesiones viejas en cache
  const adapterProvider = createProvider(Provider, {
    id: `pj-bot-${Date.now()}`,
    readIncomingMessages: true
  })

  const adapterFlow = createFlow([
    flowBienvenida,
    flowRegistroNombre,
    flowRegistroDNI,
    flowRegistroTelefono,
    flowRegistroEmail,
    flowMenuPrincipal,
    flowDenunciaCategoria,
    flowDenunciaDescripcion,
    flowDenunciaUbicacion,
    flowDenunciaLocalidad,
    flowDenunciaFechaHora,
    flowDenunciaConfirmacion
  ])

  await createBot({ flow: adapterFlow, provider: adapterProvider, database: adapterDB })

  // === Portal Web con QR ===
  QRPortal({ port: PORT })
  console.log(`🛜  QR portal ON -> http://localhost:${PORT}/`)

  // === Logs útiles de conexión / QR ===
  adapterProvider.on?.('qr', (qr) => {
    if (qr) {
      console.log('\n====== ESCANEÁ ESTE QR (fallback consola) ======\n')
      console.log(qr)
    }
  })
  adapterProvider.on?.('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u || {}
    if (qr) console.log('[connection.update] llegó un QR (también debería verse en el portal)')
    if (connection) console.log('[connection.update] estado:', connection)
    if (lastDisconnect) console.log('[connection.update] lastDisconnect:', lastDisconnect?.error?.message)
  })

  // === Alternativa: Pairing Code (sin QR) ===
  try {
    const sock = await adapterProvider.getInstance?.()
    if (sock?.requestPairingCode && WA_NUMBER) {
      const code = await sock.requestPairingCode(WA_NUMBER)
      console.log('\n===== PAIRING CODE (ingresalo en WhatsApp > Dispositivos vinculados) =====\n', code, '\n')
    }
  } catch (e) {
    console.log('No se pudo solicitar pairing code:', e?.message)
  }
}

main().catch((e) => {
  console.error('Error al iniciar bot:', e)
})
