import React, { useEffect, useMemo, useState } from 'react'
import { fetchCategorias, fetchDenuncias, fetchLocalidades, fetchUsuarios, fetchUsuarioByDni, downloadDenunciaPdf } from '../api'
import { toApiMediaUrl } from '../api'

const formatDateTime = (iso) => {
  if (!iso) return '-'
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`
}

export default function DenunciasTable() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState('')
  const [categoriaId, setCategoriaId] = useState('')
  const [localidadId, setLocalidadId] = useState('')
  const [privado, setPrivado] = useState('')
  const [loading, setLoading] = useState(true)

  const [modal, setModal] = useState({ open: false, user: null, loading: false, error: '' })
  const [downloadingId, setDownloadingId] = useState(null)

  // NUEVO: modal de adjuntos
  const [adjModal, setAdjModal] = useState({
    open: false,
    denunciaId: null,
    images: [], // [{url, mime}]
    video: null, // {url, mime} | null
    selected: null // url seleccionado para zoom
  })

  const [downloadingAdjuntos, setDownloadingAdjuntos] = useState(false)

  const [categorias, setCategorias] = useState([])
  const [localidades, setLocalidades] = useState([])
  const [usuarios, setUsuarios] = useState([])

  const usuariosById = useMemo(() => Object.fromEntries(usuarios.map(u => [String(u.id), u])), [usuarios])
  const categoriasById = useMemo(() => Object.fromEntries(categorias.map(c => [String(c.id), c])), [categorias])
  const localidadesById = useMemo(() => Object.fromEntries(localidades.map(l => [String(l.id), l])), [localidades])

  const load = async () => {
    setLoading(true)
    const [all, cats, locs, usrs] = await Promise.all([
      fetchDenuncias(),
      categorias.length ? Promise.resolve(categorias) : fetchCategorias(),
      localidades.length ? Promise.resolve(localidades) : fetchLocalidades(),
      usuarios.length ? Promise.resolve(usuarios) : fetchUsuarios()
    ])
    let filtered = Array.isArray(all) ? all.slice() : []
    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(d =>
        String(d.descripcion || '').toLowerCase().includes(q) ||
        String(d.ubicacion || '').toLowerCase().includes(q)
      )
    }
    if (categoriaId) filtered = filtered.filter(d => String(d.categoria_id || d.categoria) === String(categoriaId))
    if (localidadId) filtered = filtered.filter(d => String(d.localidad_id || d.localidad) === String(localidadId))
    if (privado !== '') filtered = filtered.filter(d => String(d.privado ? 1 : 0) === String(privado))

    const start = (page - 1) * pageSize
    const end = start + pageSize
    setItems(filtered.slice(start, end))
    setTotal(filtered.length)
    setCategorias(cats)
    setLocalidades(locs)
    setUsuarios(usrs)
    setLoading(false)
  }

  const onClickDni = async (dni) => {
    if (!dni) return
    setModal({ open: true, user: null, loading: true, error: '' })
    try {
      const data = await fetchUsuarioByDni(dni)
      setModal({ open: true, user: data, loading: false, error: '' })
    } catch (err) {
      setModal({ open: true, user: null, loading: false, error: err?.response?.data?.error || 'No se pudo obtener el usuario' })
    }
  }

  const onDownloadPdf = async (id) => {
    try {
      setDownloadingId(id)
      const blob = await downloadDenunciaPdf(id)
      const url = window.URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `denuncia_${id}.pdf`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch (e) {
      alert('No se pudo descargar el PDF')
    } finally {
      setDownloadingId(null)
    }
  }

  const triggerDownload = (url, filename) => {
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  }


  // Helpers adjuntos
  const getAdjuntoSummary = (d) => {
    const list = Array.isArray(d.adjuntos) ? d.adjuntos : []
    // compat: si backend viejo trae solo d.adjunto
    const compat = d.adjunto ? [{ tipo: 'image', url: d.adjunto, mime: 'image/*', orden: 1 }] : []
    const merged = list.length ? list : compat
    const images = merged.filter(a => a.tipo === 'image')
    const videos = merged.filter(a => a.tipo === 'video')
    return { images, videos, hasLegacy: !!d.adjunto && !list.length }
  }

  const openAdjuntosModal = (d) => {
    const { images, videos } = getAdjuntoSummary(d)
    setAdjModal({
      open: true,
      denunciaId: d.id,
      images: images.map(i => ({ url: toApiMediaUrl(i.url), mime: i.mime })), 
      video: videos.length ? { url: toApiMediaUrl(videos[0].url), mime: videos[0].mime } : null, 
      selected: null
    })
  }

  const onDownloadAdjuntos = async () => {
  if (!adjModal.denunciaId) return

  try {
    setDownloadingAdjuntos(true)

    const baseId = adjModal.denunciaId

    // Descargar imágenes
    adjModal.images.forEach((img, idx) => {
      const url = toApiMediaUrl(img.url)
      const extFromMime = img.mime?.split('/')?.[1] || 'jpg'
      const filename = `denuncia_${baseId}_img${idx + 1}.${extFromMime}`
      triggerDownload(url, filename)
    })

    // Descargar video
    if (adjModal.video) {
      const urlVideo = toApiMediaUrl(adjModal.video.url)
      const extFromMime = adjModal.video.mime?.split('/')?.[1] || 'mp4'
      const filename = `denuncia_${baseId}_video.${extFromMime}`
      triggerDownload(urlVideo, filename)
    }

  } catch (e) {
    alert('No se pudieron descargar los adjuntos')
  } finally {
    setDownloadingAdjuntos(false)
  }
  }


  useEffect(() => { load() }, [page, pageSize]) // eslint-disable-line
  useEffect(() => { setPage(1); load() }, [search, categoriaId, localidadId, privado]) // eslint-disable-line

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="container">
      <div className="card">
        <div className="toolbar">
          <div style={{flex:1}}>
            <label>Búsqueda</label>
            <input className="input" placeholder="Texto en descripción / ubicación..." value={search} onChange={e=>setSearch(e.target.value)} />
          </div>
          <div>
            <label>Categoría</label>
            <select className="select" value={categoriaId} onChange={e=>setCategoriaId(e.target.value)}>
              <option value="">Todas</option>
              {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div>
            <label>Localidad</label>
            <select className="select" value={localidadId} onChange={e=>setLocalidadId(e.target.value)}>
              <option value="">Todas</option>
              {localidades.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
          <div>
            <label>Privado</label>
            <select className="select" value={privado} onChange={e=>setPrivado(e.target.value)}>
              <option value="">Todos</option>
              <option value="1">Sí</option>
              <option value="0">No</option>
            </select>
          </div>
          <div>
            <label>Filas</label>
            <select className="select" value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}>
              {[10,20,50].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        {loading ? <p className="small">Cargando...</p> : (
          <div style={{overflowX:'auto'}}>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Descripción</th>
                  <th>Fecha/Hora</th>
                  <th>Ubicación</th>
                  <th>Categoría</th>
                  <th>Adjuntos</th>
                  <th>Usuario</th>
                  <th>Privado</th>
                  <th>Localidad</th>
                </tr>
              </thead>
              <tbody>
                {items.map(d => {
                  const usuarioKey = String(d.usuario_dni || d.usuario_id || d.usuario || '')
                  const categoriaKey = String(d.categoria_id || d.categoria || '')
                  const localidadKey = String(d.localidad_id || d.localidad || '')
                  const u = usuariosById[usuarioKey] || {}
                  const c = categoriasById[categoriaKey] || {}
                  const l = localidadesById[localidadKey] || {}

                  const { images, videos } = getAdjuntoSummary(d)
                  const imgCount = images.length
                  const vidCount = videos.length

                  return (
                    <tr key={d.id}>
                      <td>{d.id}</td>
                      <td>{d.descripcion}</td>
                      <td>{formatDateTime(d.fecha_hora)}</td>
                      <td>{d.ubicacion}</td>
                      <td><span className="badge">{c?.nombre || d.categoria || d.categoria_id}</span></td>
                      <td>
                        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                          <span className="small">
                            {imgCount} img{imgCount!==1?'s':''}{' · '}{vidCount} video{vidCount!==1?'s':''}
                          </span>
                          {(imgCount || vidCount) ? (
                            <button className="btn" onClick={()=>openAdjuntosModal(d)}>Ver adjuntos</button>
                          ) : null}
                          <button className="btn secondary" onClick={()=>onDownloadPdf(d.id)} disabled={downloadingId===d.id}>
                            {downloadingId===d.id ? 'Descargando...' : 'Descargar PDF'}
                          </button>
                        </div>
                      </td>
                      <td>
                        {d.usuario_dni ? (
                          <button className="btn secondary" onClick={()=>onClickDni(d.usuario_dni)} title="Ver datos del usuario">
                            {d.usuario_dni}
                          </button>
                        ) : (u?.dni || u?.email || d.usuario_nya || d.usuario_id || d.usuario || '—')}
                      </td>
                      <td>{d.privado ? <span className="tag">Sí</span> : 'No'}</td>
                      <td>{l?.nombre || d.localidad || d.localidad_id}</td>
                    </tr>
                  )
                })}
                {!items.length && (
                  <tr><td colSpan="9" className="small">Sin resultados</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="pagination">
          <span className="small">Total: {total}</span>
          <button className="btn secondary" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page<=1}>Anterior</button>
          <span className="small">Página {page} / {totalPages}</span>
          <button className="btn secondary" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page>=totalPages}>Siguiente</button>
        </div>
      </div>

      {/* Modal Usuario (existente) */}
      {modal.open && (
        <div className="modal-overlay" onClick={()=>setModal({ open:false, user:null, loading:false, error:'' })}>
          <div className="modal" onClick={(e)=>e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{margin:0}}>Datos del usuario</h3>
              <button className="btn secondary" onClick={()=>setModal({ open:false, user:null, loading:false, error:'' })}>Cerrar</button>
            </div>
            <div className="modal-content">
              {modal.loading && <p className="small">Cargando...</p>}
              {modal.error && <div className="badge" style={{background:'rgba(255,72,66,.15)', borderColor:'rgba(255,72,66,.35)', color:'#8b0000'}}>{modal.error}</div>}
              {modal.user && (
                <div className="row">
                  <div className="col-12"><strong>Nombre:</strong> {modal.user.nya || '-'}</div>
                  <div className="col-6"><strong>DNI:</strong> {modal.user.dni || '-'}</div>
                  <div className="col-6"><strong>Email:</strong> {modal.user.email || '-'}</div>
                  <div className="col-12"><strong>Teléfono:</strong> {modal.user.telefono || '-'}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* NUEVO: Modal de Adjuntos */}
      {adjModal.open && (
        <div className="modal-overlay" onClick={()=>setAdjModal({ open:false, denunciaId:null, images:[], video:null, selected:null })}>
          <div className="modal" onClick={(e)=>e.stopPropagation()} style={{maxWidth: '900px', width:'95%'}}>
            <div className="modal-header">
              <h3 style={{margin:0}}>Adjuntos de denuncia #{adjModal.denunciaId}</h3>
              <button className="btn secondary" onClick={()=>setAdjModal({ open:false, denunciaId:null, images:[], video:null, selected:null })}>Cerrar</button>
            </div>
            <div className="modal-content">
              {/* Grid de imágenes */}
              {adjModal.images.length > 0 ? (
                <>
                  <h4 style={{marginTop:0}}>Imágenes ({adjModal.images.length})</h4>
                  <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(140px,1fr))', gap:12}}>
                    {adjModal.images.map((img, idx) => (
                      <div key={idx} style={{border:'1px solid #eee', borderRadius:8, padding:6, textAlign:'center'}}>
                        <img
                          src={toApiMediaUrl(img.url)} //src={img.url}
                          alt={`img-${idx}`}
                          loading="lazy"
                          style={{maxWidth:'100%', maxHeight:120, objectFit:'cover', cursor:'zoom-in', borderRadius:6}}
                          onClick={()=>setAdjModal(m => ({ ...m, selected: toApiMediaUrl(img.url) }))}
                        />
                        <div style={{marginTop:6}}>
                          <a className="small" href={toApiMediaUrl(img.url)} target="_blank" rel="noopener noreferrer">Abrir en pestaña</a> 
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="small">Sin imágenes.</p>
              )}

              {/* Video (único) */}
              <hr style={{margin:'16px 0', opacity:.2}}/>
              <h4 style={{marginTop:0}}>Video</h4>
              {adjModal.video ? (
                <div style={{border:'1px solid #eee', borderRadius:8, padding:8}}>
                  <video
                    src={toApiMediaUrl(adjModal.video.url)}
                    controls
                    style={{width:'100%', maxHeight:420, borderRadius:6}}
                  />
                  <div style={{marginTop:6}}>
                    <a className="small" href={toApiMediaUrl(adjModal.video.url)} target="_blank" rel="noopener noreferrer">Abrir en pestaña</a>
                  </div>
                </div>
              ) : (
                <p className="small">Sin video.</p>
              )}
            </div>
          </div>

          {/* Lightbox simple para zoom de imagen */}
          {adjModal.selected && (
            <div
              onClick={(e)=>{ e.stopPropagation(); setAdjModal(m=>({ ...m, selected:null }))}}
              style={{
                position:'fixed', inset:0, background:'rgba(0,0,0,.75)',
                display:'flex', alignItems:'center', justifyContent:'center', zIndex:1002
              }}
            >
              <img
                src={toApiMediaUrl(adjModal.selected)}
                alt="zoom"
                style={{maxWidth:'95vw', maxHeight:'90vh', borderRadius:8, boxShadow:'0 10px 30px rgba(0,0,0,.4)'}}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
