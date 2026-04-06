// src/pages/Login.jsx
import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import api, { loginRequest } from '../api' // api=axios + loginRequest=fetch

function genCode(len = 6) {
  let s = ''
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10).toString()
  return s
}

export default function Login() {
  const { login, setSession, setActiveLocalidadId } = useAuth()
  const nav = useNavigate()

  const [loginField, setLoginField] = useState('')
  const [clave, setClave] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Preview de localidad al perder foco
  const [previewing, setPreviewing] = useState(false)
  const [previewLocName, setPreviewLocName] = useState('')
  const [preAuth, setPreAuth] = useState(null) // { token, user, login, clave, locId, locName }

  // Captcha
  const [captcha, setCaptcha] = useState(() => genCode())
  const [captchaInput, setCaptchaInput] = useState('')
  const [captchaExpiresAt, setCaptchaExpiresAt] = useState(() => Date.now() + 2 * 60 * 1000)
  const [captchaTries, setCaptchaTries] = useState(0)

  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() > captchaExpiresAt) {
        setCaptcha(genCode())
        setCaptchaInput('')
        setCaptchaTries(0)
        setCaptchaExpiresAt(Date.now() + 2 * 60 * 1000)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [captchaExpiresAt])

  const secondsLeft = useMemo(
    () => Math.max(0, Math.floor((captchaExpiresAt - Date.now()) / 1000)),
    [captchaExpiresAt]
  )

  const refreshCaptcha = () => {
    setCaptcha(genCode())
    setCaptchaInput('')
    setCaptchaTries(0)
    setCaptchaExpiresAt(Date.now() + 2 * 60 * 1000)
    setError('')
  }

  async function fetchLocalidadesConToken(token) {
    // endpoint protegido -> mandamos Bearer explícitamente (no dependemos del interceptor)
    const { data } = await api.get('/api/localidades', {
      headers: { Authorization: `Bearer ${token}` },
    })
    return Array.isArray(data) ? data : []
  }

  async function resolveLoc(token, userLocalidadRaw) {
    const locs = await fetchLocalidadesConToken(token)

    // Si user.localidad es numérico => matchea por id
    if (
      userLocalidadRaw !== null &&
      userLocalidadRaw !== undefined &&
      String(userLocalidadRaw).trim() !== '' &&
      !Number.isNaN(Number(userLocalidadRaw))
    ) {
      const idStr = String(Number(userLocalidadRaw))
      const match = locs.find((l) => String(l.id) === idStr)
      return {
        locId: match ? String(match.id) : idStr,
        locName: match?.localidad || '',
      }
    }

    // Si user.localidad es texto => matchea por nombre
    const name = String(userLocalidadRaw || '').trim().toLowerCase()
    const match = locs.find((l) => String(l.localidad || '').trim().toLowerCase() === name)
    return {
      locId: match ? String(match.id) : '',
      locName: match?.localidad || String(userLocalidadRaw || '').trim(),
    }
  }

  // ✅ Al perder foco en contraseña: validar y mostrar localidad
  const handlePasswordBlur = async () => {
    setError('')

    const u = String(loginField || '').trim()
    const p = String(clave || '').trim()
    if (!u || !p) return

    // Cache para no repetir llamadas si no cambió nada
    if (preAuth && preAuth.login === u && preAuth.clave === p) return

    setPreviewing(true)
    try {
      const res = await loginRequest(u, p) // { token, user }
      const { locId, locName } = await resolveLoc(res.token, res.user?.localidad)

      setPreviewLocName(locName || '')
      setPreAuth({
        token: res.token,
        user: res.user,
        login: u,
        clave: p,
        locId: locId || '',
        locName: locName || '',
      })
    } catch (e) {
      // No exponemos detalles: si falla, solo limpiamos preview
      setPreviewLocName('')
      setPreAuth(null)
    } finally {
      setPreviewing(false)
    }
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    setError('')

    // captcha
    if (!captchaInput) return setError('Ingresá el código de verificación.')
    if (Date.now() > captchaExpiresAt) return setError('El código expiró.')
    if (captchaInput !== captcha) {
      const tries = captchaTries + 1
      setCaptchaTries(tries)
      if (tries >= 3) {
        refreshCaptcha()
        return setError('Código incorrecto. Se generó uno nuevo.')
      }
      setCaptchaInput('')
      return setError('Código incorrecto.')
    }

    setLoading(true)
    try {
      const u = String(loginField || '').trim()
      const p = String(clave || '').trim()

      // Si ya hicimos pre-login con estas credenciales, reutilizamos
      if (preAuth && preAuth.login === u && preAuth.clave === p) {
        setSession(preAuth.token, preAuth.user)

        if (preAuth.locId) setActiveLocalidadId(preAuth.locId)
        if (preAuth.locName) localStorage.setItem('activeLocalidadNombre', preAuth.locName)

        nav('/')
        return
      }

      // Caso normal (sin preAuth)
      const res = await login(u, p)

      // Resolver localidad (id+nombre) post-login para fijar filtros y header
      const { locId, locName } = await resolveLoc(res.token, res.user?.localidad)

      if (locId) setActiveLocalidadId(locId)
      if (locName) localStorage.setItem('activeLocalidadNombre', locName)

      nav('/')
    } catch (err) {
      console.error(err)
      setError(err?.message || 'Error al iniciar sesión')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-bg">
      {/* estilos “embebidos” para no depender de tu CSS global */}
      <style>{`
        .login-bg{
          min-height:100vh;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:48px 16px;
          background:
            radial-gradient(1200px 700px at 55% 45%, rgba(18,98,148,.30), rgba(18,98,148,0) 60%),
            linear-gradient(135deg, #59c9e6 0%, #2fb0d5 20%, #1f8fbf 55%, #1b6eab 100%);
        }
        header,
        nav,
        .app-header,
        .main-header {
          display: none !important;
        }
        .login-shell{
          width:min(980px, 92vw);
          border-radius:14px;
          overflow:hidden;
          background:#fff;
          box-shadow: 0 18px 45px rgba(0,0,0,.25);
          display:grid;
          grid-template-columns: 1fr 1.1fr;
        }
        @media (max-width: 860px){
          .login-shell{ grid-template-columns: 1fr; }
          .login-left{ min-height: 220px; }
        }
        .login-left{
          background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,0)) , 
                      linear-gradient(135deg, #3fbfe0 0%, #1d7bb7 60%, #165f9e 100%);
          color:#fff;
          padding:48px 44px;
          display:flex;
          align-items:center;
          justify-content:center;
          text-align:center;
        }
        .login-left h1{
          margin:0;
          font-size:42px;
          letter-spacing:.2px;
          font-weight:800;
        }
        .login-left p{
          margin:14px 0 0 0;
          font-size:14px;
          line-height:1.5;
          opacity:.92;
        }
        .login-right{
          padding:44px 48px;
          display:flex;
          flex-direction:column;
          justify-content:center;
          gap:18px;
        }
        .login-title{
          text-align:center;
          margin:0 0 8px 0;
          font-weight:800;
          font-size:22px;
          color:#0f6ea8;
        }
        .login-form{
          display:flex;
          flex-direction:column;
          gap:14px;
        }
        .login-field label{
          display:block;
          font-size:13px;
          font-weight:700;
          color:#2a2f36;
          margin:0 0 6px 0;
        }
        .login-input{
          width:100%;
          height:44px;
          border-radius:6px;
          border:1px solid #cfd6de;
          padding:0 12px;
          outline:none;
          background:#fff;
          transition:border-color .15s ease, box-shadow .15s ease;
        }
        .login-input:focus{
          border-color:#2a86bf;
          box-shadow:0 0 0 3px rgba(42,134,191,.15);
        }
        .login-subtle{
          font-size:12px;
          opacity:.8;
          margin-top:6px;
        }
        .captcha-row{
          display:flex;
          gap:10px;
          align-items:center;
          margin-bottom:8px;
        }
        .captcha-box{
          flex:1;
          display:flex;
          align-items:center;
          justify-content:center;
          height:44px;
          border-radius:8px;
          border:1px dashed rgba(15,110,168,.55);
          background: rgba(15,110,168,.06);
          letter-spacing:6px;
          font-weight:900;
          font-size:18px;
          color:#0f6ea8;
          user-select:none;
        }
        .btn-primary{
          width:100%;
          height:44px;
          border-radius:6px;
          border:0;
          cursor:pointer;
          font-weight:800;
          color:#fff;
          background: linear-gradient(180deg, #2d84bd 0%, #1f6ea8 100%);
          box-shadow: 0 6px 14px rgba(31,110,168,.28);
          transition: transform .05s ease, filter .15s ease;
        }
        .btn-primary:active{ transform: translateY(1px); }
        .btn-primary:disabled{ opacity:.75; cursor:not-allowed; filter:saturate(.6); }
        .btn-secondary{
          height:44px;
          border-radius:8px;
          border:1px solid rgba(15,110,168,.35);
          background:#fff;
          color:#0f6ea8;
          font-weight:800;
          padding:0 14px;
          cursor:pointer;
        }
        .login-error{
          border:1px solid rgba(255,72,66,.35);
          background: rgba(255,72,66,.08);
          color:#a7221b;
          border-radius:8px;
          padding:10px 12px;
          font-weight:700;
          font-size:13px;
        }
        .login-logos{
          margin-top:8px;
          display:flex;
          align-items:center;
          justify-content:center;
          gap:14px;
          opacity:.95;
        }
        .login-logos img{
          max-height:34px;
          width:auto;
          object-fit:contain;
          filter: grayscale(0);
        }
        .login-logo {
          width: 120px;
          margin: 0 auto 24px auto;
          display: block;
          mix-blend-mode: multiply;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.15));
        }
      `}</style>

      <div className="login-shell">
        <div className="login-left">
          <div>
            <img
              src="/assets/alerta-verde-admin.png"
              alt="Alerta Verde"
              className="login-logo"
            />
            <h1>Bienvenido</h1>
            <p>Administrador de denuncias por cuestiones ambientales - Juzgados de Paz y Faltas - Poder Judicial del Chaco</p>
          </div>
        </div>

        <div className="login-right">
          <h2 className="login-title">Inicio de Sesión</h2>

          <form onSubmit={onSubmit} className="login-form">
            <div className="login-field">
              <label>Usuario</label>
              <input
                className="login-input"
                value={loginField}
                onChange={(e) => {
                  setLoginField(e.target.value)
                  setPreviewLocName('')
                  setPreAuth(null)
                }}
                required
              />
            </div>

            <div className="login-field">
              <label>Contraseña</label>
              <input
                className="login-input"
                type="password"
                value={clave}
                onChange={(e) => {
                  setClave(e.target.value)
                  setPreviewLocName('')
                  setPreAuth(null)
                }}
                onBlur={handlePasswordBlur}
                required
              />
            </div>

            <div className="login-field">
              <label>Localidad (según usuario)</label>
              <input
                className="login-input"
                value={previewing ? 'Buscando...' : (previewLocName || '')}
                disabled
              />
              <div className="login-subtle">
                Se completa al validar usuario y contraseña (al salir del campo contraseña).
              </div>
            </div>

            <div className="login-field">
              <label>Código de verificación</label>

              <div className="captcha-row">
                <div className="captcha-box">{captcha.split('').join(' ')}</div>
                <button type="button" className="btn-secondary" onClick={refreshCaptcha}>
                  Recargar
                </button>
              </div>

              <input
                className="login-input"
                inputMode="numeric"
                maxLength={6}
                placeholder="Ingresá los 6 dígitos"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
              />
              <div className="login-subtle">Expira en {Math.ceil(secondsLeft)}s</div>
            </div>

            {error && <div className="login-error">{error}</div>}

            <button className="btn-primary" disabled={loading}>
              {loading ? 'Ingresando...' : 'Iniciar Sesión'}
            </button>

            {/* Logos (opcional): ajustá rutas según tu proyecto */}
            <div className="login-logos">
              {/* <img src="/assets/poder-judicial.png" alt="Poder Judicial" /> */}
              {/* <img src="/assets/datagener.png" alt="datagener" /> */}
              <div style={{ fontSize: 12, color: '#2a2f36', opacity: 0.75, textAlign: 'center' }}>
                Poder Judicial · DTI · 2025
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
