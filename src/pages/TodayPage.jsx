import { useRef, useState } from 'react'
import { useSwipeable } from 'react-swipeable'
import JournalPanel from '../components/today/JournalPanel'
import TasksPanel from '../components/today/TasksPanel'

export default function TodayPage() {
  const insertTextRef = useRef(null)
  const [panel, setPanel] = useState('journal')

  const swipeHandlers = useSwipeable({
    onSwipedLeft: () => setPanel('tasks'),
    onSwipedRight: () => setPanel('journal'),
    trackMouse: false,
  })

  return (
    <>
      {/* Desktop: side-by-side */}
      <div className="hidden md:flex h-full" style={{ background: 'var(--bg-primary)' }}>
        <div style={{ flex: 1, borderRight: '1px solid var(--border-light)', overflow: 'hidden' }}>
          <JournalPanel onInsertText={insertTextRef} />
        </div>
        <div style={{ width: '340px', flexShrink: 0, overflow: 'hidden' }}>
          <TasksPanel />
        </div>
      </div>

      {/* Mobile: swipeable panels */}
      <div className="md:hidden flex flex-col h-full" style={{ background: 'var(--bg-primary)' }} {...swipeHandlers}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
          <button
            onClick={() => setPanel('journal')}
            style={{
              flex: 1, padding: '10px 0', fontSize: '13px', fontWeight: 500,
              fontFamily: 'var(--font-body)',
              color: panel === 'journal' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              borderBottom: panel === 'journal' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: panel === 'journal' ? `2px solid var(--accent)` : '2px solid transparent',
              transition: 'color 0.15s',
            }}
          >
            Journal
          </button>
          <button
            onClick={() => setPanel('tasks')}
            style={{
              flex: 1, padding: '10px 0', fontSize: '13px', fontWeight: 500,
              fontFamily: 'var(--font-body)',
              color: panel === 'tasks' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              borderBottom: panel === 'tasks' ? `2px solid var(--accent)` : '2px solid transparent',
              background: 'none', border: 'none', cursor: 'pointer',
              transition: 'color 0.15s',
            }}
          >
            Tasks
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {panel === 'journal' ? (
            <JournalPanel onInsertText={insertTextRef} />
          ) : (
            <TasksPanel />
          )}
        </div>
      </div>
    </>
  )
}
