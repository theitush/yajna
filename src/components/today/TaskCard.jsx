import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import { today } from '../../lib/dates'

const STATUS_LABELS = {
  active: { label: 'Active', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  done: { label: 'Done — review', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  scheduled: { label: 'Scheduled', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  backlog: { label: 'Backlog', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
}

export default function TaskCard({ task }) {
  const { markTaskDone, dismissTask, moveToBacklog, scheduleTask } = useAppStore()
  const [showSchedule, setShowSchedule] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [expanded, setExpanded] = useState(false)

  const status = STATUS_LABELS[task.status] || STATUS_LABELS.active

  const handleSchedule = () => {
    if (scheduleDate) {
      scheduleTask(task.id, scheduleDate)
      setShowSchedule(false)
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-sm font-medium text-gray-900 dark:text-white text-left flex-1"
        >
          {task.title}
        </button>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${status.cls}`}>
          {status.label}
        </span>
      </div>

      {expanded && (
        <div className="space-y-2 mb-3">
          {task.explanation && (
            <p className="text-xs text-gray-600 dark:text-gray-400">{task.explanation}</p>
          )}
          {task.feedback && (
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-2">
              <p className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-1">Feedback</p>
              <p className="text-xs text-gray-600 dark:text-gray-300">{task.feedback}</p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mt-2">
        {task.status !== 'done' && task.status !== 'dismissed' && (
          <button
            onClick={() => markTaskDone(task.id)}
            className="text-xs px-2.5 py-1 rounded-lg bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50 transition-colors"
          >
            Done
          </button>
        )}
        <button
          onClick={() => dismissTask(task.id)}
          className="text-xs px-2.5 py-1 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
        >
          Dismiss
        </button>
        {task.status !== 'backlog' && (
          <button
            onClick={() => moveToBacklog(task.id)}
            className="text-xs px-2.5 py-1 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
          >
            Backlog
          </button>
        )}
        <button
          onClick={() => setShowSchedule(s => !s)}
          className="text-xs px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors"
        >
          Schedule
        </button>
      </div>

      {showSchedule && (
        <div className="flex gap-2 mt-2">
          <input
            type="date"
            value={scheduleDate}
            min={today()}
            onChange={e => setScheduleDate(e.target.value)}
            className="text-xs border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1 flex-1 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
          />
          <button
            onClick={handleSchedule}
            className="text-xs px-3 py-1 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
          >
            Set
          </button>
        </div>
      )}
    </div>
  )
}
