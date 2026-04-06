import React, { useEffect, useMemo, useState } from 'react'
import api, {
  downloadDenunciaPdf,
  fetchCategorias,
  fetchDenuncias,
  fetchLocalidades,
  toApiMediaUrl,
} from '../api'

export default function DenunciasTable() {
  const [denuncias, setDenuncias] = useState([])
  const [categorias, setCategorias] = useState([])
  const [localidades, setLocalidades] = useState([])

  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState('')
  const [categoriaId, setCategoriaId] = useState('')
  const [localidadId, setLocalidadId] = useState(() => localStorage.getItem('activeLocalidadId') || '')
  const [privado, setPrivado] = useState('')
  const [loading, setLoading] = useState(true)

  // Fijar filtro de localidad según el usuario logueado (activeLocalidadId)
  useEffect(() => {
    const fixed = localStorage.getItem('activeLocalidadId') || ''
    if (fixed && String(localidadId) !== String(fixed)) {
      setLocalidadId(String(fixed))
    }
  }, [])

  const [modal, setModal] = useState({ open: false, user: null, loading: false, error: '' })
  const [downloadingId, setDownloadingId] = useState(null)

  // ZIP adjuntos
  const [downloadingZip, setDownloadingZip] = useState(false)

  // Modal de adjuntos
  const [adjModal, setAdjModal] = useState({
    open: false,
    denunciaId: null,
    adjuntos: [],
    loading: false,
    error: '',
    viewer: null, // { type: 'image'|'video'|'other', url, mime, name }
  })

  // Cargar datos base
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        setLoading(true)
        const [den, cats, locs] = await Promise.all([
          fetchDenuncias(),
          fetchCategorias(),
          fetchLocalidades(),
        ])
        if (!mounted) return
        setDenuncias(Array.isArray(den) ? den : [])
        setCategorias(Array.isArray(cats) ? cats : [])
        setLocalidades(Array.isArray(locs) ? locs : [])
        setTotal(Array.isArray(den) ? den.length : 0)
      } catch (err) {
        console.error(err)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  // Filtrado
  const filtered = useMemo(() => {
    let res = Array.isArray(denuncias) ? [...denuncias] : []

    const s = String(search || '').trim().toLowerCase()
    if (s) {
      res = res.filter(d => {
        const t = `${d.descripcion || ''} ${d.ubicacion || ''} ${d.localidad || ''}`.toLowerCase()
        return t.includes(s)
      })
    }

    if (categoriaId) {
      res = res.filter(d => String(d.categoria_id || d.categoria || '') === String(categoriaId))
    }

    if (localidadId) {
      res = res.filter(d => String(d.localidad_id || d.localidad) === String(localidadId))
    }

    if (privado !== '') {
      res = res.filter(d => String(d.privado) === String(privado))
    }

    return res
  }, [denuncias, search, categoriaId, localidadId, privado])

  // Paginación
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, page, pageSize])

  useEffect(() => {
    setTotal(filtered.length)
    setPage(1)
  }, [search, categoriaId, localidadId, privado])

  const openUserModal = async (userId) => {
    setModal({ open: true, user: null, loading: true, error: '' })
    try {
      const { data } = await api.get(`/api/usuarios/${userId}`)
      setModal({ open: true, user: data, loading: false, error: '' })
    } catch (err) {
      console.error(err)
      setModal({ open: true, user: null, loading: false, error: 'No se pudo cargar el usuario' })
    }
  }

  const closeUserModal = () => {
    setModal({ open: false, user: null, loading: false, error: '' })
  }

  const handleDownloadPdf = async (id) => {
    try {
      setDownloadingId(id)
      const blob = await downloadDenunciaPdf(id)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `denuncia_${id}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error(err)
      alert('No se pudo descargar el PDF')
    } finally {
      setDownloadingId(null)
    }
  }

  const openAdjuntosModal = async (denunciaId) => {
    setAdjModal({
      open: true,
      denunciaId,
      adjuntos: [],
      loading: true,
      error: '',
      viewer: null,
    })

    try {
      const { data } = await api.get(`/api/denuncias/${denunciaId}/adjuntos`)
      let arr = Array.isArray(data) ? data : []
      // Compat: si el backend solo devolviera el detalle completo (objeto con adjuntos[])
      if (!Array.isArray(data) && data && Array.isArray(data.adjuntos)) {
        arr = data.adjuntos
      }
      setAdjModal(prev => ({ ...prev, adjuntos: arr, loading: false }))
    } catch (err) {
      console.error(err)
      setAdjModal(prev => ({ ...prev, loading: false, error: 'No se pudieron cargar los adjuntos' }))
    }
  }

  const closeAdjuntosModal = () => {
    setAdjModal({
      open: false,
      denunciaId: null,
      adjuntos: [],
      loading: false,
      error: '',
      viewer: null,
    })
  }

  const openViewer = (adj) => {
    const url = toApiMediaUrl(adj.url || adj.path || adj.ruta || '')
    const tipo = String(adj.tipo || '').toLowerCase()
    let mime = adj.mime || adj.mimetype || ''
    if (!mime && tipo === 'image') mime = 'image/jpeg'
    if (!mime && tipo === 'video') mime = 'video/mp4'
    const name = adj.nombre || adj.filename || adj.titulo || (tipo === 'video' ? 'Video' : 'Imagen')

    let type = 'other'
    if (tipo === 'image' || mime.startsWith('image/')) type = 'image'
    else if (tipo === 'video' || mime.startsWith('video/')) type = 'video'

    setAdjModal(prev => ({ ...prev, viewer: { type, url, mime, name } }))
  }

  const closeViewer = () => {
    setAdjModal(prev => ({ ...prev, viewer: null }))
  }

  if (loading) {
    return <p className="small" style={{ padding: 18 }}>Cargando denuncias...</p>
  }

  return (
    <div style={{ padding: 18 }}>
      <div className="card">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label>Búsqueda</label>
            <input
              className="input"
              placeholder="Texto en descripción / ubicación..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div>
            <label>Categoría</label>
            <select
              className="select"
              value={categoriaId}
              onChange={e => setCategoriaId(e.target.value)}
            >
              <option value="">Todas</option>
              {categorias.map(c => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label>Localidad</label>
            <select
              className="select"
              value={localidadId}
              disabled
              title="La localidad se asigna según el usuario logueado"
            >
              {localidades
                .filter(l => String(l.id) === String(localidadId))
                .map(l => (
                  <option key={l.id} value={l.id}>{l.nombre}</option>
                ))}
            </select>
          </div>

          <div>
            <label>Privado</label>
            <select
              className="select"
              value={privado}
              onChange={e => setPrivado(e.target.value)}
            >
              <option value="">Todos</option>
              <option value="1">Sí</option>
              <option value="0">No</option>
            </select>
          </div>

          <div>
            <label>Filas</label>
            <select
              className="select"
              value={pageSize}
              onChange={e => setPageSize(Number(e.target.value))}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="small" style={{ marginBottom: 8 }}>
            Total: <b>{total}</b>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Fecha</th>
                  <th>Categoría</th>
                  <th>Ubicación</th>
                  <th>Privado</th>
                  <th>Usuario</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {paged.map(d => (
                  <tr key={d.id}>
                    <td>{d.id}</td>
                    <td>{d.fecha || d.created_at || ''}</td>
                    <td>{d.categoria_nombre || d.categoria || ''}</td>
                    <td>{d.ubicacion || ''}</td>
                    <td>{String(d.privado) === '1' ? 'Sí' : 'No'}</td>
                    <td>
                      <button className="btn link" onClick={() => openUserModal(d.usuario_id)}>
                        Ver
                      </button>
                    </td>
                    <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn"
                        onClick={() => handleDownloadPdf(d.id)}
                        disabled={downloadingId === d.id}
                      >
                        {downloadingId === d.id ? 'Descargando...' : 'PDF'}
                      </button>

                      <button
                        className="btn secondary"
                        onClick={() => openAdjuntosModal(d.id)}
                      >
                        Adjuntos
                      </button>
                    </td>
                  </tr>
                ))}

                {paged.length === 0 && (
                  <tr>
                    <td colSpan={7} className="small" style={{ padding: 12 }}>
                      Sin resultados
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button
              className="btn secondary"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Anterior
            </button>
            <div className="small">Página {page}</div>
            <button
              className="btn secondary"
              onClick={() => setPage(p => (p * pageSize < total ? p + 1 : p))}
              disabled={page * pageSize >= total}
            >
              Siguiente
            </button>
          </div>
        </div>
      </div>

      {/* Modal Usuario */}
      {modal.open && (
        <div className="modal-backdrop" onClick={closeUserModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Usuario</h3>
              <button className="btn secondary" onClick={closeUserModal}>Cerrar</button>
            </div>

            {modal.loading && <p className="small">Cargando...</p>}
            {modal.error && <p className="small">{modal.error}</p>}

            {modal.user && (
              <div className="small" style={{ lineHeight: 1.6 }}>
                <div><b>ID:</b> {modal.user.id}</div>
                <div><b>Nombre:</b> {modal.user.nombre || '-'}</div>
                <div><b>Login:</b> {modal.user.login || modal.user.email || '-'}</div>
                <div><b>Localidad:</b> {modal.user.localidad || '-'}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Adjuntos */}
      {adjModal.open && (
        <div className="modal-backdrop" onClick={closeAdjuntosModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 880 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Adjuntos</h3>
              <button className="btn secondary" onClick={closeAdjuntosModal}>Cerrar</button>
            </div>

            {adjModal.loading && <p className="small">Cargando...</p>}
            {adjModal.error && <p className="small">{adjModal.error}</p>}

            {!adjModal.loading && !adjModal.error && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                {adjModal.adjuntos.map((a, idx) => (
                  <button
                    key={a.id || idx}
                    className="card"
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => openViewer(a)}
                  >
                    <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>
                      {a.titulo || a.nombre || a.filename || `Adjunto ${idx + 1}`}
                    </div>
                    <div className="small" style={{ opacity: 0.75 }}>
                      {[a.mime || a.mimetype, a.tipo].filter(Boolean).join(' · ') || 'archivo'}
                    </div>
                  </button>
                ))}

                {adjModal.adjuntos.length === 0 && (
                  <div className="small">Sin adjuntos</div>
                )}
              </div>
            )}

            {/* Viewer */}
            {adjModal.viewer && (
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                  <div className="small"><b>{adjModal.viewer.name}</b></div>
                  <button className="btn secondary" onClick={closeViewer}>Cerrar vista</button>
                </div>

                {adjModal.viewer.type === 'image' && (
                  <div style={{ marginTop: 10 }}>
                    <img
                      src={toApiMediaUrl(adjModal.viewer.url)}
                      alt={adjModal.viewer.name}
                      style={{ maxWidth: '100%', borderRadius: 10 }}
                    />
                  </div>
                )}

                {adjModal.viewer.type === 'video' && (
                  <div style={{ marginTop: 10 }}>
                    <video
                      src={toApiMediaUrl(adjModal.viewer.url)}
                      controls
                      style={{ maxWidth: '100%', borderRadius: 10 }}
                    />
                  </div>
                )}

                {adjModal.viewer.type === 'other' && (
                  <div style={{ marginTop: 10 }}>
                    <a className="btn" href={toApiMediaUrl(adjModal.viewer.url)} target="_blank" rel="noreferrer">
                      Abrir archivo
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
