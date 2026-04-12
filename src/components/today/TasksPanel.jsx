import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import TaskCard from './TaskCard'

export default function TasksPanel() {
  const tasks = useAppStore(s => s.tasks)
  const addTask = useAppStore(s => s.addTask)
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')

  // Compute visible tasks inline (can't call getter as selector reliably)
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Today's Tasks
          {todayTasks.length > 0 && (
            <span className="ml-2 text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded-full">
              {todayTasks.length}
            </span>
          )}
        </h2>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
        >
          + Add
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
              <button
                onClick={handleAdd}
                className="text-xs px-3 py-1.5 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
              >
                Add task
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {todayTasks.length === 0 && !showAdd && (
          <div className="text-center py-12 text-gray-400 dark:text-gray-500">
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
