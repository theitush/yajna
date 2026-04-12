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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700/60">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Today's Tasks
          {todayTasks.length > 0 && (
            <span className="ml-2 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded-full">
              {todayTasks.length}
            </span>
          )}
        </h2>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
        >
          + Add
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {showAdd && (
          <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 border border-zinc-200 dark:border-zinc-700 space-y-2">
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleAdd()}
              placeholder="Task title…"
              className="w-full text-sm bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 rounded-lg px-3 py-2 text-zinc-900 dark:text-white placeholder-zinc-400 outline-none focus:ring-2 focus:ring-violet-500"
            />
            <textarea
              value={explanation}
              onChange={e => setExplanation(e.target.value)}
              placeholder="Explanation (optional)…"
              rows={2}
              className="w-full text-sm bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 rounded-lg px-3 py-2 text-zinc-900 dark:text-white placeholder-zinc-400 outline-none focus:ring-2 focus:ring-violet-500 resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
              >
                Add task
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="text-xs px-3 py-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {todayTasks.length === 0 && !showAdd && (
          <div className="text-center py-12 text-zinc-400 dark:text-zinc-500">
            <p className="text-sm">No tasks for today</p>
            <p className="text-xs mt-1">Add a task or schedule something for today</p>
          </div>
        )}

        {todayTasks.map(task => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  )
}
