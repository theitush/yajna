import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { today, weekKey, isVisibleToday } from '../lib/dates'
import { DEFAULT_TEMPLATE, MODE_OFFLINE } from '../lib/constants'
import {
  getTasks, putTask, putTasks, deleteTask as dbDeleteTask,
  getNotes, putNote, putNotes, deleteNote as dbDeleteNote,
  getJournal, putJournal, getConfig, putConfig,
} from '../services/db'
import { pushTasks, pushNotes, pushJournal, pushConfig, initialSync } from '../services/sync'

const useAppStore = create((set, get) => ({
  // Auth / mode
  isAuthenticated: false,
  isInitializing: true,
  mode: null, // 'drive' | 'offline'
  setAuthenticated: (v) => set({ isAuthenticated: v }),
  setInitializing: (v) => set({ isInitializing: v }),
  setMode: (mode) => set({ mode }),

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
    }
    await putTask(task)
    set(s => ({ tasks: [...s.tasks, task] }))
    if (get().mode !== MODE_OFFLINE) pushTasks().catch(console.error)
    return task
  },
  updateTask: async (id, updates) => {
    const tasks = get().tasks
    const task = tasks.find(t => t.id === id)
    if (!task) return
    const updated = { ...task, ...updates }
    await putTask(updated)
    set(s => ({ tasks: s.tasks.map(t => t.id === id ? updated : t) }))
    if (get().mode !== MODE_OFFLINE) pushTasks().catch(console.error)
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
    if (get().mode !== MODE_OFFLINE) pushTasks().catch(console.error)
  },
  reorderTasks: (orderedIds) => {
    const tasks = get().tasks
    const updated = tasks.map(t => {
      const idx = orderedIds.indexOf(t.id)
      return idx === -1 ? t : { ...t, order: idx }
    })
    set({ tasks: updated })
    putTasks(updated).then(() => {
      if (get().mode !== MODE_OFFLINE) pushTasks().catch(console.error)
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
    const note = {
      id: uuid(),
      title,
      body,
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await putNote(note)
    set(s => ({ notes: [...s.notes, note] }))
    if (get().mode !== MODE_OFFLINE) pushNotes().catch(console.error)
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
    const updated = { ...note, ...updates, title, updatedAt: new Date().toISOString() }
    await putNote(updated)
    set(s => ({ notes: s.notes.map(n => n.id === id ? updated : n) }))
    if (get().mode !== MODE_OFFLINE) pushNotes().catch(console.error)
  },
  deleteNote: async (id) => {
    await dbDeleteNote(id)
    set(s => ({ notes: s.notes.filter(n => n.id !== id) }))
    if (get().mode !== MODE_OFFLINE) pushNotes().catch(console.error)
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
    if (!doc.entries[t]) {
      doc.entries[t] = {
        content: template,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await putJournal(doc)
      if (get().mode !== MODE_OFFLINE) pushJournal(doc).catch(console.error)
    }
    set({ currentJournal: doc })
    return doc
  },
  updateJournalEntry: async (date, content) => {
    const doc = get().currentJournal
    if (!doc) return
    const updated = {
      ...doc,
      entries: {
        ...doc.entries,
        [date]: {
          ...(doc.entries[date] || {}),
          content,
          updatedAt: new Date().toISOString(),
          createdAt: doc.entries[date]?.createdAt || new Date().toISOString(),
        },
      },
    }
    await putJournal(updated)
    set({ currentJournal: updated })
    if (get().mode !== MODE_OFFLINE) pushJournal(updated).catch(console.error)
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
    if (get().mode !== MODE_OFFLINE) pushConfig().catch(console.error)
  },

  // Sync (Drive mode only)
  syncing: false,
  lastSync: null,
  runInitialSync: async () => {
    set({ syncing: true })
    try {
      await initialSync()
      const [tasks, notes, config] = await Promise.all([
        getTasks(), getNotes(), getConfig(),
      ])
      set({ tasks, notes, config: config || {}, lastSync: Date.now() })
    } catch (e) {
      console.error('Sync failed', e)
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

export default useAppStore
