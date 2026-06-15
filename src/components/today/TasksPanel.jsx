import { useState, useRef, useCallback, useEffect } from 'react'
import useAppStore from '../../store/useAppStore'
import TaskCard from './TaskCard'
import { getTaskSnapshotForDate } from '../../lib/review'
import useCurrentDay from '../../lib/useCurrentDay'

// On touch devices we drag only from the grip handle (so the card scrolls
// freely); on desktop the whole card stays grabbable as before.
const isTouchDevice = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: none) and (pointer: coarse)').matches

export default function TasksPanel({ date }) {
  const tasks = useAppStore(s => s.tasks)
  const addTask = useAppStore(s => s.addTask)
  const addTaskForDate = useAppStore(s => s.addTaskForDate)
  const reorderTasks = useAppStore(s => s.reorderTasks)
  const config = useAppStore(s => s.config)
  const [justAddedId, setJustAddedId] = useState(null)
  const todayStr = useCurrentDay(config)
  const targetDate = date || todayStr
  const isToday = targetDate === todayStr

  const [draggingId, setDraggingId] = useState(null)
  const [cloneStyle, setCloneStyle] = useState(null)
  const [shifts, setShifts] = useState({}) // id -> px shift for transform

  const draggingIdRef = useRef(null)
  const overIdRef = useRef(null)
  const itemEls = useRef({})
  const offsetRef = useRef({ x: 0, y: 0 })
  const pendingDragRef = useRef(null) // { id, startX, startY } — drag not yet committed
  const didDragRef = useRef(false) // true if a real drag (not a click) just ended
  const DRAG_THRESHOLD = 5 // px movement before drag starts

  // Derive yesterday from the live (rollover-aware) day key so the done-task
  // window agrees with the journal's notion of "today" and rolls over on the
  // same signal.
  const today = todayStr
  const yesterday = (() => {
    const d = new Date(today + 'T12:00:00')
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })()

  const todayTasks = isToday
    ? tasks
        .filter(task => {
          if (task.status === 'active') return true
          if (task.status === 'done' && (task.doneDate === today || task.doneDate === yesterday)) return true
          return false
        })
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
    : tasks
        .map(t => getTaskSnapshotForDate(t, targetDate) ? t : null)
        .filter(Boolean)
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))

  const getIds = useCallback(() => todayTasks.map(t => t.id), [todayTasks])

  const applyTransforms = useCallback((fromId, toId) => {
    const ids = getIds()
    const fromIdx = ids.indexOf(fromId)
    const toIdx = ids.indexOf(toId)
    if (fromIdx === -1 || toIdx === -1) return
    const draggedEl = itemEls.current[fromId]
    if (!draggedEl) return
    const draggedH = draggedEl.offsetHeight + 8
    const next = {}
    ids.forEach((id, i) => {
      if (id === fromId) return
      let shift = 0
      if (fromIdx < toIdx && i > fromIdx && i <= toIdx) shift = -draggedH
      else if (fromIdx > toIdx && i >= toIdx && i < fromIdx) shift = draggedH
      next[id] = shift
    })
    setShifts(next)
  }, [getIds])

  const handleMouseDown = (e, id) => {
    if (isTouchDevice) {
      // Mobile: only start a drag from the dedicated grip handle so the rest
      // of the card stays free to scroll / tap-to-edit.
      if (!e.target.closest('[data-task-drag-handle]')) return
    } else {
      // Desktop: whole card is grabbable, except interactive controls.
      const tag = e.target.tagName.toLowerCase()
      if (tag === 'button' || tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return
    }

    const el = itemEls.current[id]
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    offsetRef.current = { x: clientX - rect.left, y: clientY - rect.top }
    pendingDragRef.current = { id, startX: clientX, startY: clientY, rect }
  }

  // Follow the mouse with the clone (or activate drag from pending)
  useEffect(() => {
    const onMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX
      const clientY = e.touches ? e.touches[0].clientY : e.clientY

      // Prevent page scroll while dragging on touch
      if (e.touches && (draggingIdRef.current || pendingDragRef.current)) {
        e.preventDefault()
      }

      // Check if we should activate a pending drag
      if (!draggingIdRef.current && pendingDragRef.current) {
        const { id, startX, startY, rect } = pendingDragRef.current
        const dx = Math.abs(clientX - startX)
        const dy = Math.abs(clientY - startY)
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
          draggingIdRef.current = id
          overIdRef.current = id
          setDraggingId(id)
          setCloneStyle({
            width: rect.width,
            left: clientX - offsetRef.current.x,
            top: clientY - offsetRef.current.y,
          })
        }
        return
      }

      if (!draggingIdRef.current) return

      setCloneStyle(s => s ? {
        ...s,
        left: clientX - offsetRef.current.x,
        top: clientY - offsetRef.current.y,
      } : s)

      // Update which item we're over. We include the dragged item itself so
      // returning the pointer to the original slot snaps the shifts back to
      // zero (dropping in place) — otherwise overIdRef stays stuck on the last
      // neighbour and you can never put a card back where it started.
      const id = draggingIdRef.current
      const ids = getIds()
      let overTop = null
      let overBottom = null
      for (const tid of ids) {
        const el = itemEls.current[tid]
        if (!el) continue
        // The dragged item's own row is shifted out of the way visually, but
        // its DOM rect still sits at its original (untransformed) spot — use
        // that as the "home" hit-zone so coming back resets the order.
        const rect = el.getBoundingClientRect()
        if (overTop === null || rect.top < overTop) overTop = rect.top
        if (overBottom === null || rect.bottom > overBottom) overBottom = rect.bottom
        if (clientY >= rect.top && clientY <= rect.bottom) {
          if (tid !== overIdRef.current) {
            overIdRef.current = tid
            applyTransforms(id, tid)
          }
          break
        }
      }

      // Past-the-end rubber-band cue: when the pointer goes above the first
      // row or below the last, nudge the clone with diminishing returns so the
      // user gets the "you're at the end" feedback they'd see from native
      // scroll bounce on desktop (touch can't bounce here — we preventDefault).
      const RUBBER_MAX = 28
      let overscroll = 0
      if (overTop !== null && clientY < overTop) {
        overscroll = -Math.min(RUBBER_MAX, (overTop - clientY) * 0.35)
      } else if (overBottom !== null && clientY > overBottom) {
        overscroll = Math.min(RUBBER_MAX, (clientY - overBottom) * 0.35)
      }
      setCloneStyle(s => s ? { ...s, overscroll } : s)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('touchmove', onMove, { passive: false })
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('touchmove', onMove)
    }
  }, [applyTransforms])

  const commitDrop = useCallback(() => {
    pendingDragRef.current = null
    const from = draggingIdRef.current
    const to = overIdRef.current
    // A real drag happened (clone existed) — swallow the click the browser
    // fires next so it doesn't open the card for editing, even when dropped
    // back in place (from === to).
    didDragRef.current = !!from
    draggingIdRef.current = null
    overIdRef.current = null

    // Clear clone and shifts, reorder, and hide ghost all in one batch.
    // We clear shifts without transition (draggingId going null disables transition)
    // so the reordered positions are the source of truth — no animation back to zero.
    setCloneStyle(null)
    setShifts({})

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

    setDraggingId(null)
  }, [getIds, reorderTasks])

  useEffect(() => {
    window.addEventListener('mouseup', commitDrop)
    window.addEventListener('touchend', commitDrop)
    return () => {
      window.removeEventListener('mouseup', commitDrop)
      window.removeEventListener('touchend', commitDrop)
    }
  }, [commitDrop])

  const handleAdd = async () => {
    const task = isToday ? await addTask('') : await addTaskForDate('', targetDate)
    setJustAddedId(task.id)
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
          transform: cloneStyle.overscroll ? `translateY(${cloneStyle.overscroll}px)` : 'none',
          transition: 'transform 0.12s ease-out',
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
          <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>{isToday ? "Today's todos" : 'Tasks'}</span>
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
          onClick={handleAdd}
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

      <div
        onClickCapture={(e) => {
          // Suppress the click that follows a drag (mousedown→move→mouseup on
          // the same element still fires a native click, which would otherwise
          // expand the card for editing).
          if (didDragRef.current) {
            e.preventDefault()
            e.stopPropagation()
            didDragRef.current = false
          }
        }}
        style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        {todayTasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-tertiary)' }}>
            <p style={{ fontSize: '13px' }}>{isToday ? 'No tasks for today' : 'No tasks for this day'}</p>
            <p style={{ fontSize: '12px', marginTop: '4px' }}>{isToday ? 'Add a task or schedule something for today' : 'Add one to get started'}</p>
          </div>
        )}

        {todayTasks.map(task => (
          <div
            key={task.id}
            ref={el => { itemEls.current[task.id] = el }}
            onMouseDown={e => handleMouseDown(e, task.id)}
            onTouchStart={e => handleMouseDown(e, task.id)}
            style={{
              cursor: draggingId === task.id ? 'grabbing' : 'default',
              opacity: draggingId === task.id ? 0.25 : 1,
              userSelect: 'none',
              willChange: draggingId ? 'transform' : 'auto',
              transform: shifts[task.id] ? `translateY(${shifts[task.id]}px)` : 'none',
              transition: draggingId ? 'transform 0.15s ease' : 'none',
            }}
          >
            <TaskCard
              task={task}
              defaultExpanded={task.id === justAddedId}
              defaultEditingTitle={task.id === justAddedId}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
