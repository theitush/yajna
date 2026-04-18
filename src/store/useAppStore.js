import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { today, weekKey, isVisibleToday } from '../lib/dates'
import { MODE_OFFLINE } from '../lib/constants'
import {
  getTasks, putTask, putTasks,
  getNotes, putNote, putNotes,
  getJournal, putJournal, getAllJournals, getConfig, putConfig,
  getAllTasksRaw, getAllNotesRaw, getAllAudio,
} from '../services/db'
import { extractHashtags } from '../lib/hashtags'
import { pushTasks, pushNotes, pushJournal, pushConfig, initialSync, mergeAndPushJournal } from '../services/sync'
import { withRetry, startSyncEngine, stopSyncEngine, onSyncStatus, getSyncStatus, retryNow, setPollInterval } from '../services/syncEngine'
import { pushAudio, pushAudioMetadata, pushPendingAudio, ensureAudioLocal, softDeleteAudio, restoreAudio, hardDeleteAudio, collectAudioIdsFromBlocks } from '../services/audio'
import { putAudio, getAudio } from '../services/db'
import { stampBlocks, stampBlocksFromDoc, blocksToHtml } from '../lib/blocks'

const useAppStore = create((set, get) => ({
  // Auth / mode
  isAuthenticated: false,
  isInitializing: true,
  mode: null, // 'drive' | 'offline'
  userEmail: null,
  setAuthenticated: (v) => set({ isAuthenticated: v }),
  setInitializing: (v) => set({ isInitializing: v }),
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
  loadTasks: async () => {
    const tasks = await getTasks()
    set({ tasks })
  },
  addTask: async (title, explanation = '') => {
    const now = new Date().toISOString()
    const minOrder = get().tasks.reduce((m, t) => Math.min(m, t.order ?? 0), 0)
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
      order: minOrder - 1,
      createdAt: now,
      updatedAt: now,
    }
    await putTask(task)
    set(s => ({ tasks: [...s.tasks, task] }))
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
    const title = lines[0]?.replace(/^#+\s*/, '') || 'Untitled'
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
      title = updates.title || 'Untitled'
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

  // Journals
  currentJournal: null,
  // Tags accumulated from ALL journal weeks (so suggestions don't lose tags
  // that live in weeks other than the currently-loaded one).
  journalTagPool: [],
  loadJournalTagPool: async () => {
    try {
      const docs = await getAllJournals()
      const tagSet = new Set()
      for (const doc of docs || []) {
        for (const date in doc.entries || {}) {
          const e = doc.entries[date]
          const text = e?.content ?? blocksToHtml(e?.blocks)
          for (const tag of extractHashtags(text)) tagSet.add(tag)
        }
      }
      set({ journalTagPool: [...tagSet] })
    } catch {}
  },
  // Aggregated, always-current tag pool across notes, tasks, and journals.
  // Read via getAllTags() so editor extensions don't need React wiring.
  getAllTags: () => {
    const s = get()
    const tagSet = new Set()
    for (const n of s.notes) {
      for (const t of n.tags || []) tagSet.add(String(t).toLowerCase())
      for (const t of extractHashtags(n.body ?? blocksToHtml(n.blocks))) tagSet.add(t)
    }
    for (const t of s.tasks) {
      for (const tag of extractHashtags(`${t.title || ''} ${t.explanation || ''} ${t.feedback || ''} ${t.tags || ''}`)) tagSet.add(tag)
    }
    for (const tag of s.journalTagPool) tagSet.add(tag)
    if (s.currentJournal?.entries) {
      for (const date in s.currentJournal.entries) {
        const e = s.currentJournal.entries[date]
        const text = e?.content ?? blocksToHtml(e?.blocks)
        for (const tag of extractHashtags(text)) tagSet.add(tag)
      }
    }
    return [...tagSet].sort()
  },
  loadJournal: async (week) => {
    let doc = await getJournal(week)
    if (!doc) {
      doc = { week, entries: {} }
    }
    const t = today()

    if (get().mode !== MODE_OFFLINE) {
      doc = await mergeAndPushJournal(doc).catch(() => doc)
    }

    if (!doc.entries[t]) {
      doc = {
        ...doc,
        entries: {
          ...doc.entries,
          [t]: {
            blocks: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        },
      }
    }

    await putJournal(doc)
    set({ currentJournal: doc })
    return doc
  },
  updateJournalEntry: async (date, payload) => {
    const doc = get().currentJournal
    if (!doc) return
    const prior = doc.entries[date] || {}
    const now = new Date().toISOString()
    // Back-compat: older call sites pass a raw HTML string.
    const content = typeof payload === 'string' ? payload : (payload?.html ?? '')
    const incomingBlocks = typeof payload === 'object' && Array.isArray(payload?.blocks)
      ? payload.blocks
      : null
    const blocks = incomingBlocks
      ? stampBlocksFromDoc(prior.blocks, incomingBlocks, now)
      : stampBlocks(prior.blocks, content, now)
    const nextEntry = {
      ...prior,
      blocks,
      updatedAt: now,
      createdAt: prior.createdAt || now,
    }
    // Drop legacy `content` field if present on the prior entry — blocks is now authoritative.
    delete nextEntry.content
    const updated = {
      ...doc,
      entries: { ...doc.entries, [date]: nextEntry },
    }
    await putJournal(updated)
    set({ currentJournal: updated })
    if (get().mode !== MODE_OFFLINE) withRetry(() => pushJournal(updated))()
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
    const all = await getAllAudio()
    set({ trashedAudio: all.filter(a => a.deleted) })
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
      const date = rec.sourceId
      const week = weekKey(date)
      const doc = await getJournal(week)
      const prior = doc?.entries?.[date]
      if (!doc || !prior) {
        return { ok: false, reason: `Can't restore — journal entry for ${sourceLabel} no longer exists.` }
      }
      const blocks = Array.isArray(prior.blocks) ? [...prior.blocks, newBlock] : [newBlock]
      const updatedDoc = {
        ...doc,
        entries: {
          ...doc.entries,
          [date]: { ...prior, blocks, updatedAt: now, createdAt: prior.createdAt || now },
        },
      }
      await putJournal(updatedDoc)
      await restoreAudio(id)
      set(s => (s.currentJournal?.week === week ? { currentJournal: updatedDoc } : {}))
      if (get().mode !== MODE_OFFLINE) withRetry(() => pushJournal(updatedDoc))()
    } else {
      return { ok: false, reason: 'Unknown audio source type.' }
    }

    const all = await getAllAudio()
    set({ trashedAudio: all.filter(a => a.deleted) })
    return { ok: true }
  },
  purgeTrashedAudio: async (id) => {
    await hardDeleteAudio(id)
    const all = await getAllAudio()
    set({ trashedAudio: all.filter(a => a.deleted) })
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
  setSyncStatus: (s) => set({ syncStatus: s, syncing: s.state === 'syncing' }),
  runInitialSync: async () => {
    set({ syncing: true, syncStatus: { state: 'syncing' } })
    try {
      const result = await initialSync()
      const [tasks, notes, config] = result
        ? [result.mergedTasks, result.mergedNotes, result.mergedConfig]
        : await Promise.all([getTasks(), getNotes(), getConfig()])
      set({ tasks, notes, config: config || {}, lastSync: Date.now() })

      // Start the sync engine for continuous polling + auto-reconnect
      onSyncStatus((s) => {
        useAppStore.getState().setSyncStatus(s)
      })
      const intervalMs = (result?.mergedConfig?.syncInterval || 1) * 1000
      startSyncEngine((data) => set(data), intervalMs, () => get())
      // Upload any local audio that wasn't synced yet (deferred so it doesn't block UI)
      pushPendingAudio().catch(e => console.warn('pushPendingAudio failed', e))
      get().loadJournalTagPool()
    } catch (e) {
      console.error('Sync failed', e)
      set({ syncStatus: { state: 'offline' } })
    } finally {
      set({ syncing: false })
    }
  },

  // Offline mode boot: just load from IDB
  bootOffline: async () => {
    const [tasks, notes, config] = await Promise.all([
      getTasks(), getNotes(), getConfig(),
    ])
    set({ tasks, notes, config: config || {} })
    get().loadJournalTagPool()
  },
}))

export { retryNow, stopSyncEngine, setPollInterval }
export default useAppStore
