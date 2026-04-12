import { useRef, useState } from 'react'
import { useSwipeable } from 'react-swipeable'
import JournalPanel from '../components/today/JournalPanel'
import TasksPanel from '../components/today/TasksPanel'

export default function TodayPage() {
  const insertTextRef = useRef(null)
  const [panel, setPanel] = useState('journal') // 'journal' | 'tasks'

  const swipeHandlers = useSwipeable({
    onSwipedLeft: () => setPanel('tasks'),
    onSwipedRight: () => setPanel('journal'),
    trackMouse: false,
  })

  return (
    <>
      {/* Desktop: side-by-side */}
      <div className="hidden md:flex h-full">
        <div className="flex-1 border-r border-gray-200 dark:border-zinc-700/60 overflow-hidden">
          <JournalPanel onInsertText={insertTextRef} />
        </div>
        <div className="w-80 xl:w-96 overflow-hidden">
          <TasksPanel />
        </div>
      </div>

      {/* Mobile: swipeable panels */}
      <div className="md:hidden flex flex-col h-full" {...swipeHandlers}>
        {/* Tab switcher */}
        <div className="flex border-b border-gray-200 dark:border-zinc-700/60">
          <button
            onClick={() => setPanel('journal')}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              panel === 'journal'
                ? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400'
                : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            Journal
          </button>
          <button
            onClick={() => setPanel('tasks')}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              panel === 'tasks'
                ? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400'
                : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            Tasks
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
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
