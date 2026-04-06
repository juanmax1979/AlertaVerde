import React from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth.jsx'
import Login from './components/Login'
import DenunciasTable from './components/DenunciasTable'

function Layout({ children }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()

  const displayName = user?.nombre || user?.login || user?.email || ''
  // const displayLoc = user?.localidad || ''
  const displayLoc =
  localStorage.getItem('activeLocalidadNombre') ||
  user?.localidad ||
  ''

  
  return (
    <>
      <header className="header">
        <div className="brand">
          ⚖️ Administrador de Denuncias - Alerta Verde - Justicia de Paz y Faltas - Poder Judicial del Chaco
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          {user && (
            <div style={{ textAlign: 'right', lineHeight: 1.2 }}>
              {/* Nombre bien visible */}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: '#fff',
                }}
              >
                {displayName}
              </div>

              {/* Localidad destacada */}
              {displayLoc && (
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.18)',
                    display: 'inline-block',
                  }}
                >
                  {displayLoc}
                </div>
              )}
            </div>
          )}

          {user && (
            <button
              className="btn secondary"
              onClick={() => {
                logout()
                nav('/login')
              }}
            >
              Salir
            </button>
          )}
        </div>
      </header>

      <main>{children}</main>
    </>
  )
}

function PrivateRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <p className="small" style={{ padding: 18 }}>Cargando...</p>
  if (!user) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <DenunciasTable />
              </PrivateRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthProvider>
  )
}
