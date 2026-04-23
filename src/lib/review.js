import { blocksToHtml } from './blocks'
import { today } from './dates'

function toDateValue(dateStr) {
  return new Date(`${dateStr}T12:00:00`).getTime()
}

function addDays(dateStr, delta) {
  const next = new Date(`${dateStr}T12:00:00`)
  next.setDate(next.getDate() + delta)
  return next.toISOString().slice(0, 10)
}

export function getJournalEntryHtml(entry) {
  return entry?.content ?? blocksToHtml(entry?.blocks)
}

export function hasJournalData(entry) {
  return Boolean(getJournalEntryHtml(entry)?.trim())
}

export function getTaskReviewRecord(task, date) {
  return task.dailyReviews?.[date] || null
}

export function isTaskReviewedForDate(task, date) {
  if (getTaskReviewRecord(task, date)?.reviewedAt) return true
  return task.status === 'reviewed' && task.reviewedDate === date
}

export function getTaskSnapshotForDate(task, date) {
  const createdDate = task.createdDate || task.createdAt?.slice(0, 10)
  if (!createdDate || createdDate > date) return null

  const scheduledDate = task.scheduledDate || null
  if (scheduledDate && scheduledDate > date) return null

  const dismissedDate = task.dismissedDate || null
  if (dismissedDate && dismissedDate <= date) return null

  const reviewedDate = task.reviewedDate || null
  if (reviewedDate && reviewedDate < date) return null

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
    for (const [date, entry] of Object.entries(doc.entries || {})) {
      entries[date] = entry
    }
  }
  return entries
}

export function buildReviewDays({ tasks, journalDocs, todayStr = today() }) {
  const journalEntries = collectJournalEntries(journalDocs)
  const relevantDates = new Set()

  for (const date of Object.keys(journalEntries)) {
    if (date <= todayStr && hasJournalData(journalEntries[date])) relevantDates.add(date)
  }

  let earliestDate = todayStr
  for (const task of tasks || []) {
    const createdDate = task.createdDate || task.createdAt?.slice(0, 10)
    if (createdDate && createdDate < earliestDate) earliestDate = createdDate
  }
  for (const date of Object.keys(journalEntries)) {
    if (date < earliestDate) earliestDate = date
  }

  for (let date = earliestDate; date <= todayStr; date = addDays(date, 1)) {
    const taskSnapshots = (tasks || [])
      .map(task => getTaskSnapshotForDate(task, date))
      .filter(Boolean)

    if (taskSnapshots.length > 0) relevantDates.add(date)
  }

  return [...relevantDates]
    .filter(date => toDateValue(date) <= toDateValue(todayStr))
    .sort((a, b) => toDateValue(b) - toDateValue(a))
    .map(date => {
      const journalEntry = journalEntries[date] || null
      const taskSnapshots = (tasks || [])
        .map(task => getTaskSnapshotForDate(task, date))
        .filter(Boolean)
        .sort((a, b) => {
          if (a.completed !== b.completed) return a.completed ? 1 : -1
          return (a.order ?? Infinity) - (b.order ?? Infinity)
        })

      const hasJournal = hasJournalData(journalEntry)
      const journalReviewed = !!journalEntry?.reviewedAt
      const pendingTaskReviews = taskSnapshots.filter(task => !task.reviewed).length
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
