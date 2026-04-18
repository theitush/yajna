import { useMemo, useState, useRef, useEffect, forwardRef } from 'react'

function getActiveToken(value, caret) {
  const before = value.slice(0, caret)
  const m = before.match(/#([\p{L}\p{N}_-]*)$/u)
  if (!m) return null
  return { partial: m[1].toLowerCase(), start: caret - m[0].length, end: caret }
}

const HashtagTextarea = forwardRef(function HashtagTextarea(
  { value, onChange, allTags, style, onKeyDown, showOnFocus = true, dropdownPlacement = 'bottom', ...rest },
  ref,
) {
  const inner = useRef(null)
  useEffect(() => { if (typeof ref === 'function') ref(inner.current); else if (ref) ref.current = inner.current }, [ref])

  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef(null)

  useEffect(() => {
    const el = listRef.current?.children?.[activeIdx]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx, open])

  const token = useMemo(() => getActiveToken(value || '', caret), [value, caret])

  const suggestions = useMemo(() => {
    if (!open) return []
    if (token) {
      return allTags.filter(t => t.startsWith(token.partial) && t !== token.partial).slice(0, 20)
    }
    if ((value || '') === '' && showOnFocus) return allTags.slice(0, 20)
    return []
  }, [allTags, token, open, value, showOnFocus])

  useEffect(() => { setActiveIdx(0) }, [token?.partial, suggestions.length])

  const apply = (tag) => {
    const el = inner.current
    if (!el) return
    const v = value || ''
    let next, nextCaret
    if (token) {
      next = v.slice(0, token.start) + `#${tag} ` + v.slice(token.end)
      nextCaret = token.start + tag.length + 2
    } else {
      next = v.slice(0, caret) + `#${tag} ` + v.slice(caret)
      nextCaret = caret + tag.length + 2
    }
    onChange({ target: { value: next } })
    setOpen(false)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
      setCaret(nextCaret)
    })
  }

  const handleKeyDown = (e) => {
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => (i + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => (i - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        apply(suggestions[activeIdx])
        return
      }
      if (e.key === 'Escape') { setOpen(false); return }
    }
    onKeyDown?.(e)
  }

  const syncCaret = (e) => setCaret(e.target.selectionStart || 0)

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        {...rest}
        ref={inner}
        value={value}
        onChange={(e) => { onChange(e); setCaret(e.target.selectionStart || 0); setOpen(true) }}
        onFocus={(e) => { setOpen(true); syncCaret(e); rest.onFocus?.(e) }}
        onBlur={(e) => { setTimeout(() => setOpen(false), 150); rest.onBlur?.(e) }}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onKeyDown={handleKeyDown}
        style={style}
      />
      {open && suggestions.length > 0 && (
        <div ref={listRef} style={{
          position: 'absolute',
          ...(dropdownPlacement === 'top'
            ? { bottom: '100%', marginBottom: '4px' }
            : { top: '100%', marginTop: '4px' }),
          left: 0, right: 0,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-mid)',
          borderRadius: '8px',
          padding: '4px',
          zIndex: 30,
          display: 'flex', flexDirection: 'column', gap: '2px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          maxHeight: '220px', overflowY: 'auto',
        }}>
          {suggestions.map((tag, i) => (
            <button
              key={tag}
              onMouseDown={e => e.preventDefault()}
              onClick={e => { e.preventDefault(); e.stopPropagation(); apply(tag) }}
              style={{
                textAlign: 'left', fontSize: '12px',
                padding: '6px 10px', borderRadius: '6px',
                background: i === activeIdx ? 'var(--bg-tertiary)' : 'none',
                border: 'none', color: 'var(--accent)', cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

export default HashtagTextarea
