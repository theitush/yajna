import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { getAllTimezones, timezoneLabel } from '../lib/timezones'

// Searchable combobox over every IANA zone. Renders the current selection
// as a button; clicking opens an input + filtered list. Fuse handles fuzzy
// matching across city, zone, and offset label.
export default function TimezonePicker({ value, onChange, inputStyle }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const all = useMemo(() => getAllTimezones(), [])
  const fuse = useMemo(() => new Fuse(all, {
    keys: ['city', 'zone', 'offsetLabel'],
    threshold: 0.3,
    ignoreLocation: true,
  }), [all])

  const results = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return all.slice(0, 200)
    return fuse.search(trimmed).slice(0, 200).map(r => r.item)
  }, [query, all, fuse])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.textContent = ''
          inputRef.current.focus()
        }
      }, 0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children?.[activeIdx]
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  const commit = (zone) => {
    onChange(zone)
    setOpen(false)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = results[activeIdx]
      if (pick) commit(pick.zone)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const buttonStyle = {
    ...inputStyle,
    cursor: 'pointer',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <style>{`
        .tz-search-box:empty::before {
          content: attr(data-placeholder);
          color: var(--text-tertiary);
          pointer-events: none;
        }
        .tz-search-box:focus { outline: none; }
      `}</style>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} style={buttonStyle}>
          <span>{timezoneLabel(value)}</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>▾</span>
        </button>
      )}
      {open && (
        <>
          <div
            ref={inputRef}
            contentEditable
            suppressContentEditableWarning
            onInput={e => setQuery(e.currentTarget.textContent || '')}
            onKeyDown={onKeyDown}
            data-placeholder="Search city or zone…"
            spellCheck={false}
            style={{
              ...inputStyle,
              cursor: 'text',
              minHeight: '34px',
              whiteSpace: 'pre',
              overflow: 'hidden',
            }}
            className="tz-search-box"
          />
          <div
            ref={listRef}
            style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '4px',
              maxHeight: '260px', overflowY: 'auto',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-mid)',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              zIndex: 20,
            }}
          >
            {results.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                No matches
              </div>
            )}
            {results.map((opt, i) => {
              const isActive = i === activeIdx
              const isSelected = opt.zone === value
              return (
                <div
                  key={opt.zone}
                  onMouseDown={e => { e.preventDefault(); commit(opt.zone) }}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    padding: '8px 12px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    background: isActive ? 'var(--bg-secondary)' : 'transparent',
                    color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
                  }}
                >
                  <span>{opt.city}</span>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '12px', whiteSpace: 'nowrap' }}>
                    {opt.offsetLabel} · {opt.zone}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
