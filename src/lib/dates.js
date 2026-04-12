/**
 * Returns today's date as YYYY-MM-DD
 */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Returns yesterday's date as YYYY-MM-DD
 */
export function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Returns the ISO week key for a given date string (YYYY-MM-DD) or today
 * Format: YYYY-WWW e.g. "2026-W15"
 */
export function weekKey(dateStr) {
  const date = dateStr ? new Date(dateStr + 'T12:00:00') : new Date()
  const jan4 = new Date(date.getFullYear(), 0, 4)
  const startOfWeek1 = new Date(jan4)
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const diff = date - startOfWeek1
  const week = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * Format a date string for display
 */
export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

/**
 * Returns true if taskDate <= today
 */
export function isOnOrBeforeToday(dateStr) {
  return dateStr <= today()
}

/**
 * Determines if a task should appear in the daily view
 */
export function isVisibleToday(task) {
  const t = today()
  const y = yesterday()
  if (task.status === 'active') return true
  if (task.status === 'done' && (task.doneDate === t || task.doneDate === y)) return true
  if (task.status === 'scheduled' && task.scheduledDate && task.scheduledDate <= t) return true
  return false
}
