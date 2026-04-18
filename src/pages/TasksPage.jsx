import { useState, useMemo, useRef } from 'react'
import useAppStore from '../store/useAppStore'
import TaskCard from '../components/today/TaskCard'

const SECTIONS = [
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'done', label: 'Done' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'dismissed', label: 'Dismissed' },
]

const HASHTAG_RE = /#([\p{L}\p{N}_-]+)/gu

function extractTags(task) {
  const text = `${task.title || ''} ${task.explanation || ''} ${task.feedback || ''} ${task.tags || ''}`
  const out = new Set()
  for (const m of text.matchAll(HASHTAG_RE)) out.add(m[1].toLowerCase())
  return out
}

function matchesSearch(task, query) {
  if (!query) return true
  const q = query.toLowerCase()
  const hay = `${task.title || ''} ${task.explanation || ''} ${task.feedback || ''} ${task.tags || ''}`.toLowerCase()
  return hay.includes(q)
}

export default function TasksPage() {
  const tasks = useAppStore(s => s.tasks)
  useAppStore(s => s.notes)
  useAppStore(s => s.currentJournal)
  useAppStore(s => s.journalTagPool)
  const addTask = useAppStore(s => s.addTask)
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')
  const [openSections, setOpenSections] = useState({ active: true, scheduled: true, backlog: true })
  const [search, setSearch] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchRef = useRef(null)

  const allTags = useAppStore.getState().getAllTags()

  // Detect the hashtag token currently being typed (cursor at end of input for simplicity)
  const activeHashtag = useMemo(() => {
    const m = search.match(/#([\p{L}\p{N}_-]*)$/u)
    return m ? m[1].toLowerCase() : null
  }, [search])

  const suggestions = useMemo(() => {
    if (activeHashtag !== null) {
      return allTags.filter(t => t.startsWith(activeHashtag) && t !== activeHashtag).slice(0, 8)
    }
    if (search === '') return allTags.slice(0, 8)
    return []
  }, [allTags, activeHashtag, search])

  const applySuggestion = (tag) => {
    const next = activeHashtag !== null
      ? search.replace(/#([\p{L}\p{N}_-]*)$/u, `#${tag} `)
      : `#${tag} `
    setSearch(next)
    setShowSuggestions(false)
    searchRef.current?.focus()
  }

  const filtered = useMemo(() => tasks.filter(t => matchesSearch(t, search)), [tasks, search])

  const byStatus = SECTIONS.reduce((acc, { key }) => {
    acc[key] = filtered.filter(t => t.status === key)
    return acc
  }, {})

  const handleAdd = async () => {
    if (!title.trim()) return
    await addTask(title.trim(), explanation.trim())
    setTitle('')
    setExplanation('')
    setShowAdd(false)
  }

  const toggle = (key) => setOpenSections(s => ({ ...s, [key]: !s[key] }))

  const inputStyle = {
    width: '100%', fontSize: '13px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-mid)',
    borderRadius: '8px', padding: '8px 12px',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-body)',
    outline: 'none',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-light)',
        position: 'sticky', top: 0,
        background: 'var(--bg-primary)', zIndex: 10,
      }}>
        <h1 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)', flexShrink: 0 }}>Todos</h1>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, maxWidth: '320px', margin: '0 auto' }}>
          <input
            ref={searchRef}
            value={search}
            onChange={e => { setSearch(e.target.value); setShowSuggestions(true) }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setSearch(''); setShowSuggestions(false) }
              if (e.key === 'Tab' && suggestions.length > 0) {
                e.preventDefault()
                applySuggestion(suggestions[0])
              }
            }}
            placeholder="Search todos..."
            dir="auto"
            style={inputStyle}
          />
          {showSuggestions && suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '4px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-mid)',
              borderRadius: '8px',
              padding: '4px',
              zIndex: 20,
              display: 'flex', flexDirection: 'column', gap: '2px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}>
              {suggestions.map(tag => (
                <button
                  key={tag}
                  onMouseDown={e => { e.preventDefault(); applySuggestion(tag) }}
                  style={{
                    textAlign: 'left', fontSize: '12px',
                    padding: '6px 10px', borderRadius: '6px',
                    background: 'none', border: 'none',
                    color: 'var(--accent)', cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          style={{
            fontSize: '12px', fontWeight: 500,
            color: 'var(--accent)', background: 'var(--accent-light)',
            border: 'none', padding: '5px 14px', borderRadius: '8px',
            cursor: 'pointer', fontFamily: 'var(--font-body)', flexShrink: 0,
          }}
        >
          + Add
        </button>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {showAdd && (
          <div style={{
            background: 'var(--bg-secondary)', borderRadius: '12px',
            padding: '12px', border: '1px solid var(--border-mid)',
            display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            <input
              autoFocus value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleAdd()}
              placeholder="Task title…"
              dir="auto"
              style={inputStyle}
            />
            <textarea
              value={explanation}
              onChange={e => setExplanation(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleAdd() } }}
              placeholder="Explanation (optional)…"
              rows={2}
              dir="auto"
              style={{ ...inputStyle, resize: 'none', color: 'var(--text-secondary)', fontSize: '12px' }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleAdd} style={{
                fontSize: '12px', fontWeight: 500, color: 'var(--accent)',
                background: 'var(--accent-light)', border: 'none', padding: '5px 14px',
                borderRadius: '8px', cursor: 'pointer', fontFamily: 'var(--font-body)',
              }}>
                Add task
              </button>
              <button onClick={() => setShowAdd(false)} style={{
                fontSize: '12px', color: 'var(--text-tertiary)', background: 'none',
                border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)',
              }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {SECTIONS.map(({ key, label }) => {
          const group = byStatus[key]
          if (group.length === 0 && (key === 'done' || key === 'dismissed')) return null
          if (group.length === 0 && search) return null
          return (
            <div key={key}>
              <button
                onClick={() => toggle(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  width: '100%', textAlign: 'left', marginBottom: '8px',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <span style={{
                  fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)',
                  textTransform: 'uppercase', letterSpacing: '0.8px',
                }}>
                  {label}
                </span>
                <span style={{
                  fontSize: '11px', color: 'var(--text-tertiary)',
                  background: 'var(--bg-secondary)',
                  padding: '1px 7px', borderRadius: '20px',
                }}>
                  {group.length}
                </span>
                <svg
                  width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                  style={{
                    marginLeft: 'auto', color: 'var(--text-tertiary)',
                    transform: openSections[key] !== false ? 'none' : 'rotate(-90deg)',
                    transition: 'transform 0.15s',
                  }}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {openSections[key] !== false && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {group.length === 0 && (
                    <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '0 4px' }}>None</p>
                  )}
                  {group.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
