import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { today, dayKey, isVisibleToday } from '../lib/dates'
import { MODE_OFFLINE } from '../lib/constants'
import {
  getTasks, putTask, putTasks,
  getNotes, putNote, putNotes,
  getJournal, putJournal, getAllJournals, getConfig, putConfig,
  getAllTasksRaw, getAllNotesRaw, getAllAudio,
} from '../services/db'
import { extractHashtags } from '../lib/hashtags'
import { pushTasks, pushNotes, pushJournal, pushConfig, initialSyncStreaming, mergeAndPushJournal } from '../services/sync'
import { withRetry, startSyncEngine, stopSyncEngine, onSyncStatus, getSyncStatus, retryNow, setPollInterval } from '../services/syncEngine'
import { pushAudio, pushAudioMetadata, pushPendingAudio, ensureAudioLocal, softDeleteAudio, restoreAudio, hardDeleteAudio, collectAudioIdsFromBlocks } from '../services/audio'
import { putAudio, getAudio } from '../services/db'
import { stampBlocks, stampBlocksFromDoc, blocksToHtml } from '../lib/blocks'

function collectAudioIdsFromHtml(html) {
  const ids = []
  if (!html) return ids
  const container = document.createElement('div')
  container.innerHTML = html
  for (const el of container.querySelectorAll('[data-audio-id]')) {
    const id = el.getAttribute('data-audio-id')
    if (id) ids.push(id)
  }
  return ids
}

const useAppStore = create((set, get) => ({
  // Auth / mode
  isAuthenticated: false,
  isInitializing: true,
  initError: null,
  mode: null, // 'drive' | 'offline'
  userEmail: null,
  setAuthenticated: (v) => set({ isAuthenticated: v }),
  setInitializing: (v) => set({ isInitializing: v }),
  setInitError: (v) => set({ initError: v }),
  setMode: (mode) => set({ mode }),
  fetchUserEmail: async () => {
    try {
      const res = await window.gapi.client.request({ path: 'https://www.googleapis.com/oauth2/v3/userinfo' })
      const email = res.result?.email || null
      if (email) set({ userEmail: email })
    } catch {}
  },

  // Helper: should we push to Drive?
  get driveEnabled() {
    return get().mode !== MODE_OFFLINE
  },

  // Tasks
  tasks: [],
  reviews: {}, // date -> reviewedAt (ISO), derived from per-day journal docs
  reviewVersion: 0,
  bumpReviewVersion: () => set(s => ({ reviewVersion: s.reviewVersion + 1 })),
  rebuildReviewsFromJournals: async () => {
    const docs = await getAllJournals()
    const index = {}
    for (const doc of docs || []) {
      if (doc?.date && doc.reviewedAt) index[doc.date] = doc.reviewedAt
    }
    set({ reviews: index })
    return index
  },
  addTask: async (title, explanation = '') => {
    const now = new Date().toISOString()
    const maxOrder = get().tasks.reduce((m, t) => Math.max(m, t.order ?? 0), -1)
    const task = {
      id: uuid(),
      title,
      explanation,
      feedback: '',
      status: 'active',
      createdDate: today(),
      doneDate: null,
      dismissedDate: null,
      scheduledDate: null,
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    }
    await putTask(task)
    set(s => ({ tasks: [...s.tasks, task] }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
    return task
  },
  addTaskForDate: async (title, date, explanation = '') => {
    const now = new Date().toISOString()
    const maxOrder = get().tasks.reduce((m, t) => Math.max(m, t.order ?? 0), -1)
    const task = {
      id: uuid(),
      title,
      explanation,
      feedback: '',
      status: 'active',
      createdDate: date,
      doneDate: null,
      dismissedDate: null,
      scheduledDate: null,
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    }
    await putTask(task)
    set(s => ({ tasks: [...s.tasks, task] }))
    get().bumpReviewVersion()
    if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
    return task
  },
  updateTask: async (id, updates) => {
    const tasks = get().tasks
    const task = tasks.find(t => t.id === id)
    if (!task) return
    const updated = { ...task, ...updates, updatedAt: new Date().toISOString() }
    await putTask(updated)
    set(s => ({ tasks: s.tasks.map(t => t.id === id ? updated : t) }))
    get().bumpReviewVersion()
    if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
  },
  markTaskDone: async (id) => {
    await get().updateTask(id, { status: 'done', doneDate: today() })
  },
  markTaskActive: async (id) => {
    await get().updateTask(id, { status: 'active', doneDate: null })
  },
  markTaskReviewed: async (id) => {
    await get().updateTask(id, { status: 'reviewed', reviewedDate: today() })
  },
  dismissTask: async (id) => {
    await get().updateTask(id, { status: 'dismissed', dismissedDate: today() })
  },
  moveToBacklog: async (id) => {
    await get().updateTask(id, { status: 'backlog' })
  },
  scheduleTask: async (id, date) => {
    await get().updateTask(id, { status: 'scheduled', scheduledDate: date })
  },
  setTaskReviewedForDate: async (id, date, reviewed) => {
    const task = get().tasks.find(t => t.id === id)
    if (!task) return
    const next = { ...(task.dailyReviews || {}) }
    const prior = next[date] || {}
    if (reviewed) {
      next[date] = {
        ...prior,
        reviewedAt: new Date().toISOString(),
        completed: !!task.doneDate && task.doneDate <= date,
      }
    } else {
      next[date] = { ...prior }
      delete next[date].reviewedAt
      if (!next[date].comments?.length) delete next[date]
    }
    await get().updateTask(id, { dailyReviews: next })
  },
  addTaskReviewComment: async (id, date, text) => {
    const task = get().tasks.find(t => t.id === id)
    if (!task || !text?.trim()) return
    const dailyReviews = { ...(task.dailyReviews || {}) }
    const prior = dailyReviews[date] || {}
    const now = new Date().toISOString()
    const existing = prior.comments?.[prior.comments.length - 1]
    const comments = [{
      id: existing?.id || uuid(),
      text: text.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }]
    dailyReviews[date] = { ...prior, comments }
    await get().updateTask(id, { dailyReviews })
  },
  deleteTask: async (id) => {
    // Keep display fields on the tombstone so Trash can show the task without
    // re-hydrating content. Title/createdAt survive; everything else is fine
    // to drop. Status is preserved so we can skip done/reviewed tasks in Trash.
    const existing = get().tasks.find(t => t.id === id)
    const now = new Date().toISOString()
    const tomb = existing
      ? {
          id,
          title: existing.title || '',
          explanation: existing.explanation || '',
          feedback: existing.feedback || '',
          tags: existing.tags || '',
          status: existing.status || 'active',
          createdDate: existing.createdDate || null,
          createdAt: existing.createdAt || now,
          deleted: true,
          deletedAt: now,
          updatedAt: now,
        }
      : { id, deleted: true, deletedAt: now, updatedAt: now }
    await putTask(tomb)
    set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
    get().bumpReviewVersion()
    if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
  },
  reorderTasks: (orderedIds) => {
    const tasks = get().tasks
    const now = new Date().toISOString()
    const updated = tasks.map(t => {
      const idx = orderedIds.indexOf(t.id)
      return idx === -1 ? t : { ...t, order: idx, updatedAt: now }
    })
    set({ tasks: updated })
    putTasks(updated).then(() => {
      if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
    }).catch(console.error)
  },

  // Notes
  notes: [],
  loadNotes: async () => {
    const notes = await getNotes()
    set({ notes })
  },
  addNote: async (body = '', tags = []) => {
    const lines = body.replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean)
    const title = lines[0]?.replace(/^#+\s*/, '') || ''
    const now = new Date().toISOString()
    const note = {
      id: uuid(),
      title,
      blocks: stampBlocks([], body, now),
      tags,
      createdAt: now,
      updatedAt: now,
    }
    await putNote(note)
    set(s => ({ notes: [...s.notes, note] }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
    return note
  },
  updateNote: async (id, updates) => {
    const notes = get().notes
    const note = notes.find(n => n.id === id)
    if (!note) return
    let title
    if ('title' in updates) {
      title = updates.title ?? ''
    } else {
      title = note.title
    }
    const now = new Date().toISOString()
    const patched = { ...note, ...updates, title, updatedAt: now }
    // When body changed, prefer caller-provided blocks (derived from the live
    // editor doc and thus carrying reliable ids). Fall back to parsing HTML.
    if ('body' in updates) {
      const nextBlocks = Array.isArray(updates.blocks) ? updates.blocks : null
      patched.blocks = nextBlocks
        ? stampBlocksFromDoc(note.blocks, nextBlocks, now)
        : stampBlocks(note.blocks, updates.body, now)
    }
    delete patched.body
    const updated = patched
    await putNote(updated)
    set(s => ({ notes: s.notes.map(n => n.id === id ? updated : n) }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
  },
  deleteNote: async (id) => {
    // Keep title + blocks so the trashed note is still viewable (and so the
    // embedded audio inside it can play from Trash). The blocks are already
    // the source of truth for body content.
    const existing = get().notes.find(n => n.id === id)
    const now = new Date().toISOString()
    const tomb = existing
      ? {
          id,
          title: existing.title || 'Untitled',
          blocks: existing.blocks || [],
          tags: existing.tags || [],
          createdAt: existing.createdAt || now,
          deleted: true,
          deletedAt: now,
          updatedAt: now,
        }
      : { id, deleted: true, deletedAt: now, updatedAt: now }
    await putNote(tomb)
    set(s => ({ notes: s.notes.filter(n => n.id !== id) }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
  },

  // Journals (per-day docs keyed by date YYYY-MM-DD).
  // currentDay shape: { date, blocks, reviewedAt, blockComments, createdAt, updatedAt }
  currentDay: null,
  // Tag usage accumulated from ALL local journal days so the autocomplete
  // pool isn't limited to the currently-loaded day.
  journalTagPool: {},
  loadJournalTagPool: async () => {
    try {
      const docs = await getAllJournals()
      const usage = {}
      for (const doc of docs || []) {
        const text = blocksToHtml(doc?.blocks)
        const ts = new Date(doc?.updatedAt || 0).getTime()
        for (const tag of extractHashtags(text)) {
          const lower = tag.toLowerCase()
          if (!usage[lower] || usage[lower] < ts) usage[lower] = ts
        }
      }
      set({ journalTagPool: usage })
    } catch {}
  },
  // Aggregated, always-current tag pool across notes, tasks, and journals.
  getAllTags: () => {
    const s = get()
    const usage = { ...s.journalTagPool }

    const bump = (tag, ts) => {
      const t = String(tag).toLowerCase()
      if (!usage[t] || usage[t] < ts) usage[t] = ts
    }

    for (const n of s.notes) {
      const ts = new Date(n.updatedAt || 0).getTime()
      for (const t of n.tags || []) bump(t, ts)
      for (const t of extractHashtags(n.body ?? blocksToHtml(n.blocks))) bump(t, ts)
    }
    for (const t of s.tasks) {
      const ts = new Date(t.updatedAt || 0).getTime()
      const text = `${t.title || ''} ${t.explanation || ''} ${t.feedback || ''} ${t.tags || ''}`
      for (const tag of extractHashtags(text)) bump(tag, ts)
    }
    const cur = s.currentDay
    if (cur) {
      const ts = new Date(cur.updatedAt || 0).getTime()
      for (const tag of extractHashtags(blocksToHtml(cur.blocks))) bump(tag, ts)
    }

    return Object.keys(usage).sort((a, b) => {
      const diff = (usage[b] || 0) - (usage[a] || 0)
      return diff || a.localeCompare(b)
    })
  },
  loadJournal: async (date) => {
    const key = dayKey(date)
    let doc = await getJournal(key)
    if (!doc) {
      const now = new Date().toISOString()
      doc = {
        date: key,
        blocks: [],
        reviewedAt: null,
        blockComments: {},
        createdAt: now,
        updatedAt: new Date(0).toISOString(),
      }
    }
    const t = today()
    const config = get().config || {}

    // Daily rollover maintenance (only when loading today).
    if (key === t && config.autoDismissCompletedNextDay && config.autoDismissCompletedLastRunDate !== t) {
      const now = new Date().toISOString()
      const currentTasks = get().tasks
      const updatedTasks = currentTasks.map(task => {
        if (task.status === 'done' && task.doneDate && task.doneDate < t) {
          return { ...task, status: 'dismissed', dismissedDate: t, updatedAt: now }
        }
        return task
      })
      const hasTaskChanges = updatedTasks.some((task, i) => task !== currentTasks[i])
      if (hasTaskChanges) {
        await putTasks(updatedTasks)
        set({ tasks: updatedTasks })
        get().bumpReviewVersion()
        if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
      }

      const nextConfig = { ...config, autoDismissCompletedLastRunDate: t }
      await putConfig(nextConfig)
      set({ config: nextConfig })
      if (get().mode !== MODE_OFFLINE) withRetry(pushConfig)()
    }

    if (get().mode !== MODE_OFFLINE) {
      doc = await mergeAndPushJournal(doc).catch(() => doc)
    }

    await putJournal(doc)
    set({ currentDay: doc })
    if (doc.reviewedAt) {
      const nextReviews = { ...get().reviews, [doc.date]: doc.reviewedAt }
      set({ reviews: nextReviews })
    }
    return doc
  },
  updateJournalEntry: async (date, payload) => {
    const key = dayKey(date)
    const currentDoc = get().currentDay?.date === key ? get().currentDay : null
    let doc = currentDoc || await getJournal(key)
    if (!doc) {
      doc = {
        date: key,
        blocks: [],
        reviewedAt: null,
        blockComments: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    }
    const now = new Date().toISOString()
    // Back-compat: older call sites pass a raw HTML string.
    const content = typeof payload === 'string' ? payload : (payload?.html ?? '')
    const incomingBlocks = typeof payload === 'object' && Array.isArray(payload?.blocks)
      ? payload.blocks
      : null
    const blocks = incomingBlocks
      ? stampBlocksFromDoc(doc.blocks, incomingBlocks, now)
      : stampBlocks(doc.blocks, content, now)
    const updated = {
      ...doc,
      blocks,
      updatedAt: now,
      createdAt: doc.createdAt || now,
    }
    await putJournal(updated)
    if (currentDoc) set({ currentDay: updated })

    get().bumpReviewVersion()
    if (get().mode !== MODE_OFFLINE) {
      withRetry(() => pushJournal(updated))()
    }
  },
  setJournalEntryReviewed: async (date, reviewed) => {
    const key = dayKey(date)
    const currentDoc = get().currentDay?.date === key ? get().currentDay : null
    let doc = currentDoc || await getJournal(key)
    const now = new Date().toISOString()
    if (!doc) {
      doc = {
        date: key,
        blocks: [],
        reviewedAt: null,
        blockComments: {},
        createdAt: now,
        updatedAt: new Date(0).toISOString(),
      }
    }
    const updated = {
      ...doc,
      reviewedAt: reviewed ? now : null,
      updatedAt: now,
    }

    await putJournal(updated)
    if (currentDoc) set({ currentDay: updated })

    const nextReviews = { ...get().reviews }
    if (reviewed) nextReviews[key] = now
    else delete nextReviews[key]
    set({ reviews: nextReviews })

    get().bumpReviewVersion()
    if (get().mode !== MODE_OFFLINE) {
      withRetry(() => pushJournal(updated))()
    }
  },
  addJournalBlockComment: async (date, blockId, text) => {
    if (!blockId || !text?.trim()) return
    const key = dayKey(date)
    const currentDoc = get().currentDay?.date === key ? get().currentDay : null
    let doc = currentDoc || await getJournal(key)
    const now = new Date().toISOString()
    if (!doc) {
      doc = {
        date: key,
        blocks: [],
        reviewedAt: null,
        blockComments: {},
        createdAt: now,
        updatedAt: new Date(0).toISOString(),
      }
    }
    const blockComments = { ...(doc.blockComments || {}) }
    const existing = blockComments[blockId]?.[0]
    blockComments[blockId] = [{
      id: existing?.id || uuid(),
      text: text.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }]
    const updated = { ...doc, blockComments, updatedAt: now }

    await putJournal(updated)
    if (currentDoc) set({ currentDay: updated })
    get().bumpReviewVersion()
    if (get().mode !== MODE_OFFLINE) withRetry(() => pushJournal(updated))()
  },

  syncAllJournals: async () => {
    if (get().mode === MODE_OFFLINE) return
    const docs = await getAllJournals()
    if (!docs?.length) return
    // Merge each local day with Drive. With per-day files this is N file ops
    // — fine for typical usage but worth batching once Phase B's manifest
    // ships.
    await Promise.all(docs.map(doc => mergeAndPushJournal(doc)))
    get().bumpReviewVersion()
  },
  // Audio (local-first, lazy Drive sync)
  saveAudioBlob: async (blob, duration = 0) => {
    const id = uuid()
    const record = {
      id,
      blob,
      mimeType: blob.type || 'audio/webm',
      duration,
      createdAt: new Date().toISOString(),
    }
    await putAudio(record)
    if (get().mode !== MODE_OFFLINE) {
      withRetry(() => pushAudio(id))()
    }
    return id
  },
  getAudioRecord: async (id) => {
    if (get().mode === MODE_OFFLINE) return getAudio(id)
    return ensureAudioLocal(id)
  },
  saveAudioTranscript: async (id, transcript, model, segments) => {
    const rec = await getAudio(id)
    if (!rec) return null
    const updated = {
      ...rec,
      transcript,
      transcriptModel: model || rec.transcriptModel || null,
      transcribedAt: new Date().toISOString(),
      transcriptSegments: segments === undefined ? (rec.transcriptSegments || null) : segments,
    }
    await putAudio(updated)
    if (get().mode !== MODE_OFFLINE) {
      withRetry(() => pushAudioMetadata(id))()
    }
    return updated
  },

  // Trash: soft-deleted tasks, notes, and audio (raw reads; UI filters further).
  trashedTasks: [],
  trashedNotes: [],
  trashedAudio: [],
  loadTrash: async () => {
    const [tasksRaw, notesRaw, audioAll] = await Promise.all([
      getAllTasksRaw(), getAllNotesRaw(), getAllAudio(),
    ])
    // Only show tasks that were NOT done/reviewed when deleted.
    const trashedTasks = tasksRaw.filter(t =>
      t.deleted && !t.purged && t.title && t.status !== 'done' && t.status !== 'reviewed'
    )
    const trashedNotes = notesRaw.filter(n =>
      n.deleted && !n.purged && (n.title || (n.blocks && n.blocks.length))
    )
    const trashedAudio = audioAll.filter(a => a.deleted)
    set({ trashedTasks, trashedNotes, trashedAudio })
  },
  trashAudio: async (id, source) => {
    await softDeleteAudio(id, source)
    // Refresh the trashed list in the background so callers (e.g. the audio
    // delete button) don't wait on a full IDB scan to feel responsive. The
    // Trash page reloads on mount, so a brief delay is fine.
    getAllAudio()
      .then(all => set({ trashedAudio: all.filter(a => a.deleted) }))
      .catch(e => console.warn('refresh trashedAudio failed', e))
  },
  restoreTrashedTask: async (id) => {
    const raw = (await getAllTasksRaw()).find(t => t.id === id)
    if (!raw) return
    const now = new Date().toISOString()
    const restored = { ...raw, deleted: false, deletedAt: null, updatedAt: now }
    delete restored.purged
    await putTask(restored)
    set(s => ({
      trashedTasks: s.trashedTasks.filter(t => t.id !== id),
      tasks: [...s.tasks.filter(t => t.id !== id), restored],
    }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
  },
  restoreTrashedNote: async (id) => {
    const raw = (await getAllNotesRaw()).find(n => n.id === id)
    if (!raw) return
    const now = new Date().toISOString()
    const restored = { ...raw, deleted: false, deletedAt: null, updatedAt: now }
    delete restored.purged
    await putNote(restored)
    set(s => ({
      trashedNotes: s.trashedNotes.filter(n => n.id !== id),
      notes: [...s.notes.filter(n => n.id !== id), restored],
    }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
  },
  // Restore a trashed audio back into its source note/journal entry. If the
  // source was itself trashed or purged, returns { ok: false, reason } and
  // leaves the audio in Trash — the caller surfaces this to the user.
  restoreTrashedAudio: async (id) => {
    const rec = await getAudio(id)
    if (!rec) return { ok: false, reason: 'Audio record not found.' }
    if (!rec.sourceType || !rec.sourceId) {
      return { ok: false, reason: 'This audio has no known source to restore to.' }
    }

    const now = new Date().toISOString()
    const audioHtml = `<div data-audio-id="${rec.id}" data-duration="${rec.duration || 0}"></div>`
    const newBlock = { id: uuid(), html: audioHtml, updatedAt: now }
    const sourceLabel = rec.sourceTitle || (rec.sourceType === 'journal' ? 'journal entry' : 'note')

    if (rec.sourceType === 'note') {
      const noteRaw = (await getAllNotesRaw()).find(n => n.id === rec.sourceId)
      if (!noteRaw) {
        return { ok: false, reason: `Can't restore — source note "${sourceLabel}" was permanently deleted.` }
      }
      if (noteRaw.deleted) {
        return { ok: false, reason: `Can't restore — source note "${sourceLabel}" is in Trash. Restore the note first.` }
      }
      const blocks = Array.isArray(noteRaw.blocks) ? [...noteRaw.blocks, newBlock] : [newBlock]
      const updatedNote = { ...noteRaw, blocks, updatedAt: now }
      await putNote(updatedNote)
      await restoreAudio(id)
      set(s => ({
        notes: [...s.notes.filter(n => n.id !== updatedNote.id), updatedNote],
      }))
      if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
    } else if (rec.sourceType === 'journal') {
      const date = dayKey(rec.sourceId)
      const doc = await getJournal(date)
      if (!doc) {
        return { ok: false, reason: `Can't restore — journal entry for ${sourceLabel} no longer exists.` }
      }
      const blocks = Array.isArray(doc.blocks) ? [...doc.blocks, newBlock] : [newBlock]
      const updatedDoc = { ...doc, blocks, updatedAt: now, createdAt: doc.createdAt || now }
      await putJournal(updatedDoc)
      await restoreAudio(id)
      set(s => (s.currentDay?.date === date ? { currentDay: updatedDoc } : {}))
      if (get().mode !== MODE_OFFLINE) withRetry(() => pushJournal(updatedDoc))()
    } else {
      return { ok: false, reason: 'Unknown audio source type.' }
    }

    const all = await getAllAudio()
    set({ trashedAudio: all.filter(a => a.deleted) })
    return { ok: true }
  },
  getAudioReferenceCount: async (audioId) => {
    if (!audioId) return { total: 0, notes: 0, journals: 0 }
    const [notesRaw, journals] = await Promise.all([getAllNotesRaw(), getAllJournals()])
    let notesCount = 0
    let journalsCount = 0

    for (const n of notesRaw || []) {
      if (!n || n.purged) continue
      const ids = collectAudioIdsFromBlocks(n.blocks)
      for (const id of ids) if (id === audioId) notesCount++
    }

    for (const doc of journals || []) {
      if (!doc) continue
      const ids = Array.isArray(doc.blocks)
        ? collectAudioIdsFromBlocks(doc.blocks)
        : collectAudioIdsFromHtml(blocksToHtml(doc.blocks))
      for (const id of ids) if (id === audioId) journalsCount++
    }

    return { total: notesCount + journalsCount, notes: notesCount, journals: journalsCount }
  },
  purgeTrashedAudio: async (id) => {
    const refs = await get().getAudioReferenceCount(id)
    if (refs.total > 0) {
      await restoreAudio(id)
      const all = await getAllAudio()
      set({ trashedAudio: all.filter(a => a.deleted) })
      return { ok: true, keptAudioFile: true }
    }

    await hardDeleteAudio(id)
    const all = await getAllAudio()
    set({ trashedAudio: all.filter(a => a.deleted) })
    return { ok: true, removedAudioFile: true }
  },
  purgeTrashedTask: async (id) => {
    // Keep the tombstone so other devices see the delete, but mark it purged
    // so the trash UI ignores it even if raw reads pick it up.
    const raw = (await getAllTasksRaw()).find(t => t.id === id)
    if (!raw) return
    const now = new Date().toISOString()
    await putTask({ id, deleted: true, deletedAt: raw.deletedAt || now, updatedAt: now, purged: true })
    set(s => ({ trashedTasks: s.trashedTasks.filter(t => t.id !== id) }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushTasks)()
  },
  purgeTrashedNote: async (id) => {
    const raw = (await getAllNotesRaw()).find(n => n.id === id)
    if (!raw) return
    // Hard-delete every audio blob embedded in the note so blobs + Drive files go away.
    const audioIds = collectAudioIdsFromBlocks(raw.blocks)
    for (const aid of audioIds) {
      try { await hardDeleteAudio(aid) } catch (e) { console.warn('audio purge failed', aid, e) }
    }
    const now = new Date().toISOString()
    await putNote({ id, deleted: true, deletedAt: raw.deletedAt || now, updatedAt: now, purged: true })
    set(s => ({ trashedNotes: s.trashedNotes.filter(n => n.id !== id) }))
    const all = await getAllAudio()
    set({ trashedAudio: all.filter(a => a.deleted) })
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
  },

  // Config
  config: {},
  loadConfig: async () => {
    const config = await getConfig()
    set({ config: config || {} })
  },
  updateConfig: async (updates) => {
    const config = { ...get().config, ...updates }
    await putConfig(config)
    set({ config })
    if (get().mode !== MODE_OFFLINE) withRetry(pushConfig)()
  },

  // Sync (Drive mode only)
  syncing: false,
  lastSync: null,
  syncStatus: { state: 'offline' }, // { state: 'synced'|'syncing'|'offline'|'waiting', retryIn?: number }
  // Per-surface gates. False during initial connect; flipped true as each
  // staged-pull bucket resolves. Once true they stay true — incremental polls
  // are cheap and merge-safe via writeGeneration, no need to re-gate.
  // Offline mode: everything is immediately ready since there's no Drive merge.
  syncReady: { today: false, tasks: false, notes: false, audio: false },
  markSyncReady: (bucket) => set(s => ({
    syncReady: { ...s.syncReady, [bucket]: true },
  })),
  markAllSyncReady: () => set({
    syncReady: { today: true, tasks: true, notes: true, audio: true },
  }),
  setSyncStatus: (s) => {
    const updates = { syncStatus: s, syncing: s.state === 'syncing' }
    if (s.isAuth) {
      updates.initError = s.message || 'Session expired. Please sign in again.'
    }
    set(updates)
  },
  /**
   * Run the initial Drive merge. Hydrates the store per-bucket as each
   * bucket lands, so callers awaiting `priorityBuckets` can render the
   * active screen as soon as its data is ready, while the rest finishes
   * in the background.
   *
   * @param {Object} [opts]
   * @param {string[]} [opts.priorityBuckets] - one or more of
   *   'tasks' | 'notes' | 'config'. Awaited before this call's
   *   returned promise resolves. Background buckets keep going either way.
   * @returns {Promise<void>} resolves when priority buckets are hydrated.
   *   Background work (other buckets, drive writeback, sync engine startup)
   *   continues without blocking.
   */
  runInitialSync: async (opts = {}) => {
    const priorityBuckets = Array.isArray(opts.priorityBuckets) && opts.priorityBuckets.length
      ? opts.priorityBuckets.filter(b => b !== 'reviews')
      : ['tasks', 'notes', 'config']

    set({ syncing: true, syncStatus: { state: 'syncing' } })

    let handle
    try {
      handle = initialSyncStreaming()
    } catch (e) {
      // Synchronous failure to even start the merge — fall back to local reads.
      console.error('Sync failed to start', e)
      const [tasks, notes, config] = await Promise.all([getTasks(), getNotes(), getConfig()])
      set({ tasks, notes, config: config || {}, lastSync: Date.now() })
      set({ syncing: false, syncStatus: { state: 'offline' } })
      await get().rebuildReviewsFromJournals().catch(() => {})
      return
    }

    handle.buckets.today.then(() => {
      get().markSyncReady('today')
    }).catch(() => { get().markSyncReady('today') })
    handle.buckets.tasks.then(tasks => {
      if (tasks != null) set({ tasks })
      get().markSyncReady('tasks')
    }).catch(() => { get().markSyncReady('tasks') })
    handle.buckets.audio.then(() => {
      get().markSyncReady('audio')
    }).catch(() => { get().markSyncReady('audio') })
    handle.buckets.notes.then(notes => {
      if (notes != null) set({ notes })
      get().markSyncReady('notes')
    }).catch(() => { get().markSyncReady('notes') })
    handle.buckets.config.then(config => {
      if (config != null) set({ config: config || {} })
    }).catch(() => {})

    // Tail work that depends on the full merge being done: lastSync stamp,
    // sync engine startup, deferred audio uploads, tag pool refresh.
    handle.done.then((result) => {
      // Belt-and-suspenders: if any bucket promise resolved with null
      // (no Drive ids etc.) the store may still be empty — fill from local.
      ;(async () => {
        const s = get()
        const fills = []
        if (!s.tasks?.length) fills.push(getTasks().then(v => set({ tasks: v })))
        if (!s.notes?.length) fills.push(getNotes().then(v => set({ notes: v })))
        if (!Object.keys(s.config || {}).length) fills.push(getConfig().then(v => set({ config: v || {} })))
        await Promise.all(fills)
        await get().rebuildReviewsFromJournals().catch(() => {})
      })().catch(() => {})

      set({ lastSync: Date.now(), syncing: false })

      onSyncStatus((s) => {
        useAppStore.getState().setSyncStatus(s)
      })
      const intervalMs = (result?.mergedConfig?.syncInterval || 1) * 1000
      startSyncEngine((data) => set(data), intervalMs, () => get())
      pushPendingAudio().catch(e => console.warn('pushPendingAudio failed', e))
      get().loadJournalTagPool()
    }).catch((e) => {
      console.error('Sync failed', e)
      const code = e?.status || e?.result?.error?.code
      if (code === 401 || code === 403) {
        get().setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
      } else {
        set({ syncStatus: { state: 'offline' } })
      }
      // Don't keep surfaces gated if the merge bailed — local data is still
      // viewable; the next poll will hydrate fresh remote data.
      get().markAllSyncReady()
      onSyncStatus((s) => {
        useAppStore.getState().setSyncStatus(s)
      })
      startSyncEngine((data) => set(data), 1000, () => get())
      set({ syncing: false })
    })

    // Wait only on the priority buckets before returning. Background buckets
    // keep going via the .then() handlers above.
    await Promise.all(priorityBuckets.map(b => handle.buckets[b]).filter(Boolean))
  },

  // Offline mode boot: just load from IDB
  bootOffline: async () => {
    const [tasks, notes, config] = await Promise.all([
      getTasks(), getNotes(), getConfig(),
    ])
    set({ tasks, notes, config: config || {} })
    // No Drive merge to wait on — every surface is immediately editable.
    get().markAllSyncReady()
    await get().rebuildReviewsFromJournals().catch(() => {})
    get().loadJournalTagPool()
  },
}))

export { retryNow, stopSyncEngine, setPollInterval }
export default useAppStore
