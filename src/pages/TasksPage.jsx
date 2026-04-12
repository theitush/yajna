import { useState } from 'react'
import useAppStore from '../store/useAppStore'
import TaskCard from '../components/today/TaskCard'
import { today } from '../lib/dates'

const SECTIONS = [
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'done', label: 'Done' },
  { key: 'dismissed', label: 'Dismissed' },
]

export default function TasksPage() {
  const tasks = useAppStore(s => s.tasks)
  const addTask = useAppStore(s => s.addTask)
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')
  const [openSections, setOpenSections] = useState({ active: true, scheduled: true, backlog: true })

  const byStatus = SECTIONS.reduce((acc, { key }) => {
    acc[key] = tasks.filter(t => t.status === key)
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

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-900 z-10">
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">Tasks</h1>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
        >
          + Add task
        </button>
      </div>

      <div className="p-4 space-y-4">
        {showAdd && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 border border-gray-200 dark:border-gray-700 space-y-2">
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleAdd()}
              placeholder="Task title…"
              className="w-full text-sm bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-violet-500"
            />
            <textarea
              value={explanation}
              onChange={e => setExplanation(e.target.value)}
              placeholder="Explanation (optional)…"
              rows={2}
              className="w-full text-sm bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-violet-500 resize-none"
            />
            <div className="flex gap-2">
              <button onClick={handleAdd} className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700">
                Add task
              </button>
              <button onClick={() => setShowAdd(false)} className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
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
                className="flex items-center gap-2 w-full text-left mb-2"
              >
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  {label}
                </span>
                <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded-full">
                  {group.length}
                </span>
                <ChevronIcon open={openSections[key] !== false} />
              </button>
              {openSections[key] !== false && (
                <div className="space-y-2">
                  {group.length === 0 && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 px-1">None</p>
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

function ChevronIcon({ open }) {
  return (
    <svg
      className={`w-3 h-3 text-gray-400 transition-transform ml-auto ${open ? '' : '-rotate-90'}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
    >
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  )
}
