import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import TaskCard from './TaskCard'

export default function TasksPanel() {
  const tasks = useAppStore(s => s.tasks)
  const addTask = useAppStore(s => s.addTask)
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')

  const { today, yesterday } = (() => {
    const t = new Date().toISOString().slice(0, 10)
    const d = new Date(); d.setDate(d.getDate() - 1)
    const y = d.toISOString().slice(0, 10)
    return { today: t, yesterday: y }
  })()

  const todayTasks = tasks.filter(task => {
    if (task.status === 'active') return true
    if (task.status === 'done' && (task.doneDate === today || task.doneDate === yesterday)) return true
    if (task.status === 'scheduled' && task.scheduledDate && task.scheduledDate <= today) return true
    return false
  })

  const handleAdd = async () => {
    if (!title.trim()) return
    await addTask(title.trim(), explanation.trim())
    setTitle('')
    setExplanation('')
    setShowAdd(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  )
}
