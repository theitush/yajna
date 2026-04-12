import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { today, weekKey, isVisibleToday } from '../lib/dates'
import { DEFAULT_TEMPLATE } from '../lib/constants'
import {
  getTasks, putTask, putTasks, deleteTask as dbDeleteTask,
  getNotes, putNote, putNotes, deleteNote as dbDeleteNote,
  getJournal, putJournal, getConfig, putConfig,
} from '../services/db'
import { pushTasks, pushNotes, pushJournal, pushConfig, initialSync } from '../services/sync'

const useAppStore = create((set, get) => ({
  // Auth
  isAuthenticated: false,
  isInitializing: true,
  setAuthenticated: (v) => set({ isAuthenticated: v }),
  setInitializing: (v) => set({ isInitializing: v }),

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
    pushTasks().catch(console.error)
    return task
  },
  updateTask: async (id, updates) => {
    const tasks = get().tasks
    const task = tasks.find(t => t.id === id)
    if (!task) return
    const updated = { ...task, ...updates }
    await putTask(updated)
    set(s => ({ tasks: s.tasks.map(t => t.id === id ? updated : t) }))
    pushTasks().catch(console.error)
  },
  markTaskDone: async (id) => {
    await get().updateTask(id, { status: 'done', doneDate: today() })
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
    pushTasks().catch(console.error)
  },
  get todayTasks() {
    return get().tasks.filter(isVisibleToday)
  },

  // Notes
  notes: [],
  loadNotes: async () => {
    const notes = await getNotes()
    set({ notes })
  },
  addNote: async (body = '', tags = []) => {
    const lines = body.split('\n').filter(Boolean)
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
    pushNotes().catch(console.error)
    return note
  },
  updateNote: async (id, updates) => {
    const notes = get().notes
    const note = notes.find(n => n.id === id)
    if (!note) return
    const lines = (updates.body ?? note.body).split('\n').filter(Boolean)
    const title = lines[0]?.replace(/^#+\s*/, '') || note.title
    const updated = { ...note, ...updates, title, updatedAt: new Date().toISOString() }
    await putNote(updated)
    set(s => ({ notes: s.notes.map(n => n.id === id ? updated : n) }))
    pushNotes().catch(console.error)
  },
  deleteNote: async (id) => {
    await dbDeleteNote(id)
    set(s => ({ notes: s.notes.filter(n => n.id !== id) }))
    pushNotes().catch(console.error)
  },

  // Journals
  currentJournal: null, // { week, entries: { [date]: { content, createdAt, updatedAt } } }
  loadJournal: async (week) => {
    let doc = await getJournal(week)
    if (!doc) {
      doc = { week, entries: {} }
    }
    // Ensure today's entry exists
    const t = today()
    if (!doc.entries[t]) {
      doc.entries[t] = {
        content: DEFAULT_TEMPLATE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await putJournal(doc)
      pushJournal(doc).catch(console.error)
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
    pushJournal(updated).catch(console.error)
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
    pushConfig().catch(console.error)
  },

  // Sync
  syncing: false,
  lastSync: null,
  runInitialSync: async () => {
    set({ syncing: true })
    try {
      await initialSync()
      // Reload all local data after sync
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
}))

export default useAppStore
