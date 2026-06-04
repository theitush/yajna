import { blocksToHtml } from './blocks'
import { currentJournalDay } from './dates'

function toDateValue(dateStr) {
  return new Date(`${dateStr}T12:00:00`).getTime()
}

function addDays(dateStr, delta) {
  const next = new Date(`${dateStr}T12:00:00`)
  next.setDate(next.getDate() + delta)
  return next.toISOString().slice(0, 10)
}

export function getJournalEntryHtml(entry) {
  if (!entry) return ''
  return blocksToHtml(entry.blocks)
}

export function hasJournalData(entry) {
  return Boolean(getJournalEntryHtml(entry)?.trim())
}

export function getTaskReviewRecord(task, date) {
  return task.dailyReviews?.[date] || null
}

export function isTaskReviewedForDate(task, date) {
  if (getTaskReviewRecord(task, date)?.reviewedAt) return true
  return false
}

export function getTaskSnapshotForDate(task, date) {
  const createdDate = task.createdDate || task.createdAt?.slice(0, 10)
  if (!createdDate || createdDate > date) return null
  if (task.status === 'backlog') return null

  const dismissedDate = task.dismissedDate || null
  if (dismissedDate && dismissedDate <= date) return null

  const doneDate = task.doneDate || null
  if (doneDate && doneDate < date) return null

  const completed = doneDate === date
  const reviewRecord = getTaskReviewRecord(task, date)
  const reviewed = isTaskReviewedForDate(task, date)
  return {
    ...task,
    reviewDate: date,
    completed,
    reviewed,
    reviewRecord,
    comments: reviewRecord?.comments || [],
  }
}

export function collectJournalEntries(journalDocs) {
  const entries = {}
  for (const doc of journalDocs || []) {
    if (doc?.date) entries[doc.date] = doc
  }
  return entries
}

// Review shows only PAST days. `currentDay` is the rollover-aware current
// journal day (zone + 4am boundary) and is the EXCLUSIVE upper bound — today's
// day and anything after it (the empty "tomorrow" placeholder) are filtered
// out. Callers pass currentJournalDay(config); the default is a config-less
// fallback for tests/back-compat.
export function buildReviewDays({ tasks, journalDocs, reviews, currentDay = currentJournalDay() }) {
  const journalEntries = collectJournalEntries(journalDocs)
  const relevantDates = new Set()

  for (const date of Object.keys(journalEntries)) {
    if (date < currentDay && hasJournalData(journalEntries[date])) relevantDates.add(date)
  }

  // Also include dates from the global reviews index if they have a review timestamp
  if (reviews) {
    for (const date of Object.keys(reviews)) {
      if (date < currentDay) relevantDates.add(date)
    }
  }

  let earliestDate = currentDay
  for (const task of tasks || []) {
    const createdDate = task.createdDate || task.createdAt?.slice(0, 10)
    if (createdDate && createdDate < earliestDate) earliestDate = createdDate
  }
  for (const date of Object.keys(journalEntries)) {
    if (date < earliestDate) earliestDate = date
  }

  for (let date = earliestDate; date < currentDay; date = addDays(date, 1)) {
    const taskSnapshots = (tasks || [])
      .map(task => getTaskSnapshotForDate(task, date))
      .filter(Boolean)

    if (taskSnapshots.length > 0) relevantDates.add(date)
  }

  return [...relevantDates]
    .filter(date => toDateValue(date) < toDateValue(currentDay))
    .sort((a, b) => toDateValue(b) - toDateValue(a))
    .map(date => {
      const journalEntry = journalEntries[date] || null
      const taskSnapshots = (tasks || [])
        .map(task => getTaskSnapshotForDate(task, date))
        .filter(Boolean)
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))

      const hasJournal = hasJournalData(journalEntry)
      const journalReviewed = !!(reviews?.[date] || journalEntry?.reviewedAt)
      const pendingTaskReviews = taskSnapshots.filter(task => task.completed && !task.reviewed).length
      const needsReview = (hasJournal && !journalReviewed) || pendingTaskReviews > 0

      return {
        date,
        journalEntry,
        journalReviewed,
        hasJournal,
        tasks: taskSnapshots,
        pendingTaskReviews,
        needsReview,
      }
    })
}
