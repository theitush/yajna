import { useState, useRef, useEffect } from 'react'

const SIZES = [
  { label: 'Title',   type: 'heading', level: 1 },
  { label: 'Header',  type: 'heading', level: 2 },
  { label: 'Subhead', type: 'heading', level: 3 },
  { label: 'Normal',  type: 'paragraph' },
]

const HIGHLIGHTS = [
  { color: '#fef08a', label: 'Yellow' },
  { color: '#bbf7d0', label: 'Green'  },
  { color: '#bfdbfe', label: 'Blue'   },
  { color: '#e9d5ff', label: 'Purple' },
]

const btnBase = {
  fontSize: '12px',
  color: 'var(--text-secondary)',
  background: 'none',
  border: 'none',
  padding: '5px 8px',
  borderRadius: '6px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '3px',
  transition: 'background 0.12s',
  fontFamily: 'var(--font-body)',
  userSelect: 'none',
}

const btnActive = {
  ...btnBase,
  background: 'rgba(107,163,214,0.15)',
  color: 'var(--accent)',
}

function ToolBtn({ active, onMouseDown, title, children }) {
  return (
    <button onMouseDown={onMouseDown} title={title} style={active ? btnActive : btnBase}>
      {children}
    </button>
  )
}

function Divider() {
  return <span style={{ width: 1, height: 16, background: 'var(--border-light)', margin: '0 4px', flexShrink: 0 }} />
}

export default function EditorToolbar({ editor }) {
  const [sizeOpen, setSizeOpen] = useState(false)
  const [hlOpen, setHlOpen] = useState(false)
  const sizeRef = useRef(null)
  const hlRef = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (sizeRef.current && !sizeRef.current.contains(e.target)) setSizeOpen(false)
      if (hlRef.current && !hlRef.current.contains(e.target)) setHlOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (!editor) return null

  const currentSize = SIZES.find(s =>
    s.type === 'heading'
      ? editor.isActive('heading', { level: s.level })
      : editor.isActive('paragraph')
  ) || SIZES[3]

  const activeHighlight = HIGHLIGHTS.find(h => editor.isActive('highlight', { color: h.color }))
  const isCentered = editor.isActive({ textAlign: 'center' })

  function applySize(s) {
    if (s.type === 'heading') {
      editor.chain().focus().toggleHeading({ level: s.level }).run()
    } else {
      editor.chain().focus().setParagraph().run()
    }
    setSizeOpen(false)
  }

  function applyHighlight(color) {
    if (editor.isActive('highlight', { color })) {
      editor.chain().focus().unsetHighlight().run()
    } else {
      editor.chain().focus().setHighlight({ color }).run()
    }
    setHlOpen(false)
  }

  function clearHighlight() {
    editor.chain().focus().unsetHighlight().run()
    setHlOpen(false)
  }

  const dropdownStyle = {
    position: 'absolute', top: '100%', left: 0, marginTop: '2px',
    zIndex: 50,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-mid)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    overflow: 'hidden',
    minWidth: '90px',
  }

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '1px',
      padding: '4px 12px',
      borderBottom: '1px solid var(--border-light)',
      background: 'var(--bg-secondary)',
    }}>

      {/* Size dropdown */}
      <div ref={sizeRef} style={{ position: 'relative' }}>
        <button
          onMouseDown={(e) => { e.preventDefault(); setSizeOpen(o => !o) }}
          style={{ ...btnBase, minWidth: '62px', justifyContent: 'space-between' }}
        >
          {currentSize.label}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.5 }}>
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {sizeOpen && (
          <div style={dropdownStyle}>
            {SIZES.map(s => (
              <button
                key={s.label}
                onMouseDown={(e) => { e.preventDefault(); applySize(s) }}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '7px 12px', fontSize: '12px',
                  background: s.label === currentSize.label ? 'rgba(107,163,214,0.1)' : 'transparent',
                  color: s.label === currentSize.label ? 'var(--accent)' : 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontWeight: s.level === 1 ? 700 : s.level === 2 ? 600 : 400,
                  fontSize: s.level === 1 ? '0.85rem' : '0.75rem',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <Divider />

      <ToolBtn
        active={editor.isActive('bold')}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run() }}
        title="Bold"
      ><strong>B</strong></ToolBtn>

      <ToolBtn
        active={editor.isActive('underline')}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run() }}
        title="Underline"
      ><u>U</u></ToolBtn>

      <ToolBtn
        active={editor.isActive('italic')}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run() }}
        title="Italic"
      ><em>I</em></ToolBtn>

      <Divider />

      <ToolBtn
        active={isCentered}
        onMouseDown={(e) => {
          e.preventDefault()
          if (isCentered) editor.chain().focus().setTextAlign('left').run()
          else editor.chain().focus().setTextAlign('center').run()
        }}
        title="Center"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M4 6h16M7 12h10M4 18h16" />
        </svg>
      </ToolBtn>

      <Divider />

      {/* Highlight picker */}
      <div ref={hlRef} style={{ position: 'relative' }}>
        <button
          onMouseDown={(e) => { e.preventDefault(); setHlOpen(o => !o) }}
          title="Highlight"
          style={hlOpen || activeHighlight ? btnActive : btnBase}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z" />
            <path d="M3 21h6" />
          </svg>
          {activeHighlight && (
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: activeHighlight.color, border: '1px solid rgba(255,255,255,0.2)' }} />
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.5 }}>
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {hlOpen && (
          <div style={{ ...dropdownStyle, minWidth: '110px', padding: '6px' }}>
            {HIGHLIGHTS.map(h => (
              <button
                key={h.color}
                onMouseDown={(e) => { e.preventDefault(); applyHighlight(h.color) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '5px 8px', borderRadius: '6px', fontSize: '12px',
                  background: editor.isActive('highlight', { color: h.color }) ? 'rgba(107,163,214,0.1)' : 'transparent',
                  color: 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                }}
              >
                <span style={{ width: 12, height: 12, borderRadius: '3px', background: h.color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.1)' }} />
                {h.label}
              </button>
            ))}
            <div style={{ height: 1, background: 'var(--border-light)', margin: '4px 0' }} />
            <button
              onMouseDown={(e) => { e.preventDefault(); clearHighlight() }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                padding: '5px 8px', borderRadius: '6px', fontSize: '12px',
                color: 'var(--text-tertiary)', background: 'transparent',
                border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: '3px', background: 'transparent', flexShrink: 0, border: '1px solid var(--border-mid)' }} />
              None
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
