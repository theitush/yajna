import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { today, weekKey, isVisibleToday } from '../lib/dates'
import { DEFAULT_TEMPLATE, MODE_OFFLINE } from '../lib/constants'
import {
  getTasks, putTask, putTasks, deleteTask as dbDeleteTask,
  getNotes, putNote, putNotes, deleteNote as dbDeleteNote,
  getJournal, putJournal, getConfig, putConfig,
} from '../services/db'
import { pushTasks, pushNotes, pushJournal, pushConfig, initialSync, mergeAndPushJournal } from '../services/sync'
import { withRetry, startSyncEngine, stopSyncEngine, onSyncStatus, getSyncStatus, retryNow, setPollInterval } from '../services/syncEngine'
import { pushAudio, pushAudioMetadata, pushPendingAudio, ensureAudioLocal } from '../services/audio'
import { putAudio, getAudio } from '../services/db'
import { stampBlocks, stampBlocksFromDoc } from '../lib/blocks'

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
    await dbDeleteTask(id)
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
      body,
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
    const updated = patched
    await putNote(updated)
    set(s => ({ notes: s.notes.map(n => n.id === id ? updated : n) }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
  },
  deleteNote: async (id) => {
    await dbDeleteNote(id)
    set(s => ({ notes: s.notes.filter(n => n.id !== id) }))
    if (get().mode !== MODE_OFFLINE) withRetry(pushNotes)()
  },

  // Journals
  currentJournal: null,
  loadJournal: async (week) => {
    let doc = await getJournal(week)
    if (!doc) {
      doc = { week, entries: {} }
    }
    const t = today()
    const config = get().config
    const template = config?.journalTemplate || DEFAULT_TEMPLATE

    // Merge with Drive FIRST, before inserting any template. Otherwise a fresh
    // template entry (stamped "now") races real remote content and can win.
    if (get().mode !== MODE_OFFLINE) {
      doc = await mergeAndPushJournal(doc).catch(() => doc)
    }

    // Only insert the template if today's entry is truly absent on both sides
    // after merge. Mark it with epoch timestamps so any real edit wins merges.
    if (!doc.entries[t]) {
      doc = {
        ...doc,
        entries: {
          ...doc.entries,
          [t]: {
            content: template,
            blocks: [],
            createdAt: new Date().toISOString(),
            // Epoch updatedAt: any real edit supersedes the untouched template.
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
    const updated = {
      ...doc,
      entries: {
        ...doc.entries,
        [date]: {
          ...prior,
          content,
          blocks,
          updatedAt: now,
          createdAt: prior.createdAt || now,
        },
      },
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
  saveAudioTranscript: async (id, transcript, model) => {
    const rec = await getAudio(id)
    if (!rec) return null
    const updated = {
      ...rec,
      transcript,
      transcriptModel: model || rec.transcriptModel || null,
      transcribedAt: new Date().toISOString(),
    }
    await putAudio(updated)
    if (get().mode !== MODE_OFFLINE) {
      withRetry(() => pushAudioMetadata(id))()
    }
    return updated
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
  },
}))

export { retryNow, stopSyncEngine, setPollInterval }
export default useAppStore
