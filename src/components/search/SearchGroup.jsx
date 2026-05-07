import { useEffect, useState } from 'react'

const STORAGE_PREFIX = 'yajna.search.group.'

export default function SearchGroup({ id, label, count, defaultOpen = true, emptyLabel = 'No matches', children }) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(STORAGE_PREFIX + id)
      if (v === '1') return true
      if (v === '0') return false
    } catch { /* localStorage unavailable */ }
    return defaultOpen
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_PREFIX + id, open ? '1' : '0') } catch { /* ignore */ }
  }, [id, open])

  return (
    <div style={{ marginBottom: '14px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '4px 0', marginBottom: '6px',
          fontFamily: 'var(--font-body)',
        }}
      >
        <span style={{
          fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)',
          textTransform: 'uppercase', letterSpacing: '0.8px',
        }}>{label}</span>
        <span style={{
          fontSize: '11px', color: 'var(--text-tertiary)',
          background: 'var(--bg-secondary)',
          padding: '1px 7px', borderRadius: '20px',
        }}>{count}</span>
        <svg
          width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
          style={{
            marginLeft: 'auto', color: 'var(--text-tertiary)',
            transform: open ? 'none' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
          }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {count === 0
            ? <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '0 4px' }}>{emptyLabel}</p>
            : children}
        </div>
      )}
    </div>
  )
}
