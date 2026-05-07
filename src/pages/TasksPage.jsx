import { useEffect, useRef, useState } from 'react'
import useAppStore from '../store/useAppStore'
import TaskCard from '../components/today/TaskCard'
import useHighlightTarget from '../lib/useHighlightTarget'

const SECTIONS = [
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'done', label: 'Done' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'dismissed', label: 'Dismissed' },
]

export default function TasksPage() {
  const tasks = useAppStore(s => s.tasks)
  const addTask = useAppStore(s => s.addTask)
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')
  const [openSections, setOpenSections] = useState({ active: true, scheduled: true, backlog: true })
  const highlightId = useHighlightTarget('id')
  const highlightRef = useRef(null)

  const byStatus = SECTIONS.reduce((acc, { key }) => {
    acc[key] = tasks.filter(t => t.status === key)
    return acc
  }, {})

  // When arriving from search with ?id=…, expand the section that contains
  // the task and scroll the card into view. The marker styling is applied
  // via the `search-highlight` class on the wrapping div.
  useEffect(() => {
    if (!highlightId) return
    const target = tasks.find(t => t.id === highlightId)
    if (!target) return
    if (target.status && openSections[target.status] === false) {
      setOpenSections(s => ({ ...s, [target.status]: true }))
    }
    // Wait one frame for layout / sections to expand, then scroll.
    const t = setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, tasks])

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
        <h1 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)', flex: 1 }}>Todos</h1>
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
                  {group.map(task => {
                    const isHL = task.id === highlightId
                    return (
                      <div
                        key={task.id}
                        ref={isHL ? highlightRef : null}
                        className={isHL ? 'search-highlight' : undefined}
                      >
                        <TaskCard task={task} />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
