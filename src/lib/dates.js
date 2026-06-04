/**
 * Returns today's date as YYYY-MM-DD
 */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone.
 * en-CA gives ISO-shaped output (e.g. "2026-05-25").
 */
function formatDateInZone(date, zone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/**
 * The "journal day" in effect right now, honoring a configured timezone and
 * day-rollover hour. With rollover at 04:00, the hours 00:00–03:59 still
 * belong to the previous calendar day so late-night entries don't jump ahead.
 *
 * cfg shape: { dayRolloverZone?: string, dayRolloverHour?: number 0–23 }
 * Missing or invalid config falls back to literal local today().
 */
export function currentJournalDay(cfg) {
  const zone = cfg?.dayRolloverZone
  const hour = Number.isFinite(cfg?.dayRolloverHour) ? cfg.dayRolloverHour : 0
  const now = new Date()
  if (!zone) {
    if (!hour) return today()
    const shifted = new Date(now.getTime() - hour * 3600_000)
    return formatDateInZone(shifted, Intl.DateTimeFormat().resolvedOptions().timeZone)
  }
  const shifted = new Date(now.getTime() - hour * 3600_000)
  return formatDateInZone(shifted, zone)
}

/**
 * Normalizes a date input (Date or string) to a YYYY-MM-DD day key.
 * Falls back to today's date when no input is provided.
 */
export function dayKey(input) {
  if (!input) return today()
  if (input instanceof Date) return input.toISOString().slice(0, 10)
  const s = String(input)
  return s.length >= 10 ? s.slice(0, 10) : today()
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
  return false
}
