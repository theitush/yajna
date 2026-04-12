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

function ToolBtn({ active, onMouseDown, title, children }) {
  return (
    <button
      onMouseDown={onMouseDown}
      title={title}
      className={`px-1.5 py-0.5 rounded text-xs font-medium transition-colors select-none
        ${active
          ? 'bg-violet-600 text-white'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
        }`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-0.5 shrink-0" />
}

export default function EditorToolbar({ editor }) {
  const [sizeOpen, setSizeOpen] = useState(false)
  const [hlOpen, setHlOpen] = useState(false)
  const sizeRef = useRef(null)
  const hlRef = useRef(null)

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e) {
      if (sizeRef.current && !sizeRef.current.contains(e.target)) setSizeOpen(false)
      if (hlRef.current && !hlRef.current.contains(e.target)) setHlOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (!editor) return null

  // Determine current size label
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

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 py-1 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">

      {/* Size dropdown */}
      <div ref={sizeRef} className="relative">
        <button
          onMouseDown={(e) => { e.preventDefault(); setSizeOpen(o => !o) }}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors select-none min-w-[62px]"
        >
          {currentSize.label}
          <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {sizeOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden min-w-[90px]">
            {SIZES.map(s => (
              <button
                key={s.label}
                onMouseDown={(e) => { e.preventDefault(); applySize(s) }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors
                  ${s.label === currentSize.label
                    ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                style={s.level === 1 ? { fontWeight: 700, fontSize: '0.85rem' } : s.level === 2 ? { fontWeight: 600 } : {}}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <Divider />

      {/* Bold */}
      <ToolBtn
        active={editor.isActive('bold')}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run() }}
        title="Bold"
      ><strong>B</strong></ToolBtn>

      {/* Underline */}
      <ToolBtn
        active={editor.isActive('underline')}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run() }}
        title="Underline"
      ><u>U</u></ToolBtn>

      <Divider />

      {/* Center */}
      <ToolBtn
        active={isCentered}
        onMouseDown={(e) => {
          e.preventDefault()
          if (isCentered) {
            editor.chain().focus().setTextAlign('left').run()
          } else {
            editor.chain().focus().setTextAlign('center').run()
          }
        }}
        title="Center"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M7 12h10M4 18h16" />
        </svg>
      </ToolBtn>

      <Divider />

      {/* Highlight picker */}
      <div ref={hlRef} className="relative">
        <button
          onMouseDown={(e) => { e.preventDefault(); setHlOpen(o => !o) }}
          title="Highlight"
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-colors select-none
            ${hlOpen || activeHighlight
              ? 'bg-violet-600 text-white'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
        >
          {/* Marker icon */}
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h6" />
          </svg>
          {/* Active color dot */}
          {activeHighlight && (
            <span className="w-2 h-2 rounded-full border border-white/50" style={{ backgroundColor: activeHighlight.color }} />
          )}
          <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {hlOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 flex flex-col gap-1 min-w-[110px]">
            {HIGHLIGHTS.map(h => (
              <button
                key={h.color}
                onMouseDown={(e) => { e.preventDefault(); applyHighlight(h.color) }}
                className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors
                  ${editor.isActive('highlight', { color: h.color })
                    ? 'bg-violet-50 dark:bg-violet-900/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                  } text-gray-700 dark:text-gray-300`}
              >
                <span className="w-3 h-3 rounded-sm shrink-0 border border-gray-300 dark:border-gray-600" style={{ backgroundColor: h.color }} />
                {h.label}
              </button>
            ))}
            <div className="h-px bg-gray-200 dark:bg-gray-600 my-0.5" />
            <button
              onMouseDown={(e) => { e.preventDefault(); clearHighlight() }}
              className="flex items-center gap-2 px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <span className="w-3 h-3 rounded-sm shrink-0 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800" />
              None
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
