import { useRef, useState } from 'react'
import JournalPanel from '../components/today/JournalPanel'
import TasksPanel from '../components/today/TasksPanel'
import SurfaceLoadingGate from '../components/layout/SurfaceLoadingGate'
import useAppStore from '../store/useAppStore'
import useMediaQuery, { MD_BREAKPOINT } from '../lib/useMediaQuery'

export default function TodayPage() {
  const insertTextRef = useRef(null)
  const [panel, setPanel] = useState('journal')
  const config = useAppStore(s => s.config)
  const updateConfig = useAppStore(s => s.updateConfig)
  // Mount exactly one layout. Rendering both and CSS-hiding one (the old
  // `hidden md:flex` / `md:hidden` pair) kept two live JournalPanel editors
  // mounted — the hidden twin still subscribed to the store and re-ran
  // setContent on every currentDay bump, fighting the visible editor and
  // causing the online typing lag.
  const isDesktop = useMediaQuery(MD_BREAKPOINT)

  const showTasks = config.showTasksToday !== false

  const toggleTasks = () => {
    updateConfig({ showTasksToday: !showTasks })
  }

  return isDesktop ? (
    <DesktopLayout
      insertTextRef={insertTextRef}
      showTasks={showTasks}
      toggleTasks={toggleTasks}
    />
  ) : (
    <MobileLayout
      insertTextRef={insertTextRef}
      panel={panel}
      setPanel={setPanel}
    />
  )
}

function DesktopLayout({ insertTextRef, showTasks, toggleTasks }) {
  return (
      <div className="flex h-full relative" style={{ background: 'var(--bg-primary)' }}>
        <div style={{
          flex: 1,
          borderRight: showTasks ? '1px solid var(--border-light)' : 'none',
          overflow: 'hidden',
          transition: 'border-right 0.3s ease'
        }}>
          <JournalPanel onInsertText={insertTextRef} />
        </div>

        {/* Toggle Button */}
        <button
          onClick={toggleTasks}
          style={{
            position: 'absolute',
            right: showTasks ? '340px' : '0',
            top: '3%',
            transform: 'translate(50%, -50%)',
            zIndex: 100,
            width: '20px',
            height: '40px',
            borderRadius: '4px',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-light)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--text-tertiary)',
            transition: 'right 0.3s ease, color 0.15s',
            padding: 0,
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-tertiary)'}
          title={showTasks ? "Hide todos" : "Show todos"}
        >
          {showTasks ? <ChevronRight /> : <ChevronLeft />}
        </button>

        <div style={{
          width: showTasks ? '340px' : '0',
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'width 0.3s ease',
          background: 'var(--bg-primary)',
        }}>
          {/* The page-level gate (bucket="today") only tracks the journal
              merge — tasks merge separately, so the panel gets its own gate
              to block task edits on a stale list without freezing the editor. */}
          <div style={{ width: '340px', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <SurfaceLoadingGate bucket="tasks" label="Loading tasks...">
              <TasksPanel />
            </SurfaceLoadingGate>
          </div>
        </div>
      </div>
  )
}

function MobileLayout({ insertTextRef, panel, setPanel }) {
  return (
      <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
          <button
            onClick={() => setPanel('journal')}
            style={{
              flex: 1, padding: '10px 0', fontSize: '13px', fontWeight: 500,
              fontFamily: 'var(--font-body)',
              color: panel === 'journal' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              borderBottom: panel === 'journal' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', border: 'none', cursor: 'pointer',
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
            Todos
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {panel === 'journal' ? (
            <JournalPanel onInsertText={insertTextRef} />
          ) : (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <SurfaceLoadingGate bucket="tasks" label="Loading tasks...">
                <TasksPanel />
              </SurfaceLoadingGate>
            </div>
          )}
        </div>
      </div>
  )
}

function ChevronLeft() {
  return <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><polyline points="15 18 9 12 15 6"/></svg>
}

function ChevronRight() {
  return <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><polyline points="9 18 15 12 9 6"/></svg>
}
