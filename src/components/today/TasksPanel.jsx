import { useState, useRef, useCallback, useEffect } from 'react'
import useAppStore from '../../store/useAppStore'
import TaskCard from './TaskCard'

export default function TasksPanel() {
  const tasks = useAppStore(s => s.tasks)
  const addTask = useAppStore(s => s.addTask)
  const reorderTasks = useAppStore(s => s.reorderTasks)
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')

  const [draggingId, setDraggingId] = useState(null)
  const [cloneStyle, setCloneStyle] = useState(null)

  const draggingIdRef = useRef(null)
  const overIdRef = useRef(null)
  const itemEls = useRef({})
  const offsetRef = useRef({ x: 0, y: 0 })

  const { today, yesterday } = (() => {
    const t = new Date().toISOString().slice(0, 10)
    const d = new Date(); d.setDate(d.getDate() - 1)
    const y = d.toISOString().slice(0, 10)
    return { today: t, yesterday: y }
  })()

  const todayTasks = tasks
    .filter(task => {
      if (task.status === 'active') return true
      if (task.status === 'done' && (task.doneDate === today || task.doneDate === yesterday)) return true
      if (task.status === 'scheduled' && task.scheduledDate && task.scheduledDate <= today) return true
      return false
    })
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))

  const getIds = () => todayTasks.map(t => t.id)

  const applyTransforms = useCallback((fromId, toId) => {
    const ids = getIds()
    const fromIdx = ids.indexOf(fromId)
    const toIdx = ids.indexOf(toId)
    if (fromIdx === -1 || toIdx === -1) return
    ids.forEach((id, i) => {
      const el = itemEls.current[id]
      if (!el || id === fromId) return
      const draggedEl = itemEls.current[fromId]
      if (!draggedEl) return
      const draggedH = draggedEl.offsetHeight + 8
      let shift = 0
      if (fromIdx < toIdx && i > fromIdx && i <= toIdx) shift = -draggedH
      else if (fromIdx > toIdx && i >= toIdx && i < fromIdx) shift = draggedH
      el.style.transition = 'transform 0.15s ease'
      el.style.transform = shift ? `translateY(${shift}px)` : 'none'
    })
  }, [todayTasks])

  const clearTransforms = useCallback(() => {
    getIds().forEach(id => {
      const el = itemEls.current[id]
      if (el) {
        el.style.transition = 'transform 0.15s ease'
        el.style.transform = 'none'
      }
    })
  }, [todayTasks])

  // Follow the mouse with the clone
  useEffect(() => {
    if (!draggingId) return
    const onMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY
      setCloneStyle(s => s ? {
        ...s,
        left: clientX - offsetRef.current.x,
        top: clientY - offsetRef.current.y,
      } : s)

      // Update which item we're over
      const id = draggingIdRef.current
      for (const [tid, el] of Object.entries(itemEls.current)) {
        if (!el || tid === id) continue
        const rect = el.getBoundingClientRect()
        if (clientY >= rect.top && clientY <= rect.bottom) {
          if (tid !== overIdRef.current) {
            overIdRef.current = tid
            applyTransforms(id, tid)
          }
          break
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('touchmove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('touchmove', onMove)
    }
  }, [draggingId, applyTransforms])

  const handleMouseDown = (e, id) => {
    const tag = e.target.tagName.toLowerCase()
    if (tag === 'button' || tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return
    e.preventDefault()

    const el = itemEls.current[id]
    if (!el) return
    const rect = el.getBoundingClientRect()
    offsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }

    draggingIdRef.current = id
    overIdRef.current = id
    setDraggingId(id)
    setCloneStyle({
      width: rect.width,
      left: e.clientX - offsetRef.current.x,
      top: e.clientY - offsetRef.current.y,
    })
  }

  const commitDrop = useCallback(() => {
    const from = draggingIdRef.current
    const to = overIdRef.current
    clearTransforms()
    if (from && to && from !== to) {
      const ids = getIds()
      const fromIdx = ids.indexOf(from)
      const toIdx = ids.indexOf(to)
      if (fromIdx !== -1 && toIdx !== -1) {
        const reordered = [...ids]
        reordered.splice(fromIdx, 1)
        reordered.splice(toIdx, 0, from)
        reorderTasks(reordered)
      }
    }
    draggingIdRef.current = null
    overIdRef.current = null
    setDraggingId(null)
    setCloneStyle(null)
  }, [todayTasks, reorderTasks, clearTransforms])

  useEffect(() => {
    if (!draggingId) return
    window.addEventListener('mouseup', commitDrop)
    window.addEventListener('touchend', commitDrop)
    return () => {
      window.removeEventListener('mouseup', commitDrop)
      window.removeEventListener('touchend', commitDrop)
    }
  }, [draggingId, commitDrop])

  const handleAdd = async () => {
    if (!title.trim()) return
    await addTask(title.trim(), explanation.trim())
    setTitle('')
    setExplanation('')
    setShowAdd(false)
  }

  const draggingTask = draggingId ? todayTasks.find(t => t.id === draggingId) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Floating clone */}
      {draggingTask && cloneStyle && (
        <div style={{
          position: 'fixed',
          left: cloneStyle.left,
          top: cloneStyle.top,
          width: cloneStyle.width,
          pointerEvents: 'none',
          zIndex: 1000,
          opacity: 0.95,
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          borderRadius: '12px',
        }}>
          <TaskCard task={draggingTask} />
        </div>
      )}

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>Today's todos</span>
          {todayTasks.length > 0 && (
            <span style={{
              fontSize: '12px', color: 'var(--text-tertiary)',
              background: 'var(--bg-secondary)',
              padding: '1px 8px', borderRadius: '20px',
            }}>
              {todayTasks.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          style={{
            fontSize: '12px', fontWeight: 500,
            color: 'var(--accent)',
            background: 'var(--accent-light)',
            border: 'none', padding: '5px 14px',
            borderRadius: '8px', cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            transition: 'background 0.15s',
          }}
        >
          + Add
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {showAdd && (
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            padding: '12px',
            border: '1px solid var(--border-mid)',
            display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleAdd()}
              placeholder="Task title…"
              style={{
                width: '100%', fontSize: '13px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-mid)',
                borderRadius: '8px', padding: '8px 12px',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-body)',
                outline: 'none',
              }}
            />
            <textarea
              value={explanation}
              onChange={e => setExplanation(e.target.value)}
              placeholder="Explanation (optional)…"
              rows={2}
              style={{
                width: '100%', fontSize: '12px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-mid)',
                borderRadius: '8px', padding: '8px 12px',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-body)',
                outline: 'none', resize: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleAdd}
                style={{
                  fontSize: '12px', fontWeight: 500,
                  color: 'var(--accent)',
                  background: 'var(--accent-light)',
                  border: 'none', padding: '5px 14px',
                  borderRadius: '8px', cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                }}
              >
                Add task
              </button>
              <button
                onClick={() => setShowAdd(false)}
                style={{
                  fontSize: '12px',
                  color: 'var(--text-tertiary)',
                  background: 'none', border: 'none',
                  cursor: 'pointer', fontFamily: 'var(--font-body)',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {todayTasks.length === 0 && !showAdd && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-tertiary)' }}>
            <p style={{ fontSize: '13px' }}>No tasks for today</p>
            <p style={{ fontSize: '12px', marginTop: '4px' }}>Add a task or schedule something for today</p>
          </div>
        )}

        {todayTasks.map(task => (
          <div
            key={task.id}
            ref={el => { itemEls.current[task.id] = el }}
            onMouseDown={e => handleMouseDown(e, task.id)}
            style={{
              cursor: draggingId === task.id ? 'grabbing' : 'grab',
              opacity: draggingId === task.id ? 0.25 : 1,
              userSelect: 'none',
              willChange: 'transform',
            }}
          >
            <TaskCard task={task} />
          </div>
        ))}
      </div>
    </div>
  )
}
