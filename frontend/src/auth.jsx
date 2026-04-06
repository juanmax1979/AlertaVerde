// src/auth.jsx
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { loginRequest } from './api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // ✅ Localidad activa (persistente)
  const [activeLocalidadId, _setActiveLocalidadId] = useState(
    () => localStorage.getItem('activeLocalidadId') || ''
  )

  function setActiveLocalidadId(id) {
    const v = String(id || '')
    localStorage.setItem('activeLocalidadId', v)
    _setActiveLocalidadId(v)
  }

  // ✅ setSession: permite setear token+user desde un pre-login (onBlur) o login normal
  function setSession(token, userObj) {
    if (token) localStorage.setItem('token', token)
    if (userObj) {
      localStorage.setItem('user', JSON.stringify(userObj))
      setUser(userObj)
    }
  }

  useEffect(() => {
    const token = localStorage.getItem('token')
    const userStr = localStorage.getItem('user')

    if (token && userStr) {
      try {
        setUser(JSON.parse(userStr))
      } catch {
        localStorage.removeItem('user')
      }
    }

    setLoading(false)
  }, [])

  const login = async (login, clave) => {
    const res = await loginRequest(login, clave)
    setSession(res.token, res.user)
    return res
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    localStorage.removeItem('activeLocalidadId')
    localStorage.removeItem('activeLocalidadNombre') // ✅ para el header (nombre)
    setUser(null)
    _setActiveLocalidadId('')
  }

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      activeLocalidadId,
      setActiveLocalidadId,
      setSession, // ✅ nuevo
    }),
    [user, loading, activeLocalidadId]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
