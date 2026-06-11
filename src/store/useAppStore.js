import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { today, dayKey, currentJournalDay } from '../lib/dates'
import { detectBrowserTimezone } from '../lib/timezones'
import { MODE_OFFLINE, SYNC_PAUSED_KEY } from '../lib/constants'
import {
  getTasks, putTask, putTasks, getTask,
  getNotes, putNote,
  getJournal, putJournal, getAllJournals, getConfig, putConfigWithDoc,
  getAllTasksRaw, getAllNotesRaw, getAllAudio,
  putMeta,
} from '../services/db'
import { extractHashtags } from '../lib/hashtags'
import { pushTasks, pushNotes, pushJournal, pushConfig, initialSyncStreaming, mergeAndPushJournal, flushPendingSync } from '../services/sync'
import { withRetry, startSyncEngine, stopSyncEngine, onSyncStatus, retryNow, setPollInterval, pullNow } from '../services/syncEngine'
import { pushAudio, pushPendingAudio, ensureAudioLocal, softDeleteAudio, restoreAudio, hardDeleteAudio, collectAudioIdsFromBlocks, audioBlockHtml } from '../services/audio'
import { putAudio, getAudio } from '../services/db'
import { withAuthRetry } from '../services/auth'
import { stampBlocks, stampBlocksFromDoc, blocksToHtml } from '../lib/blocks'
import { logSync } from '../services/syncLog'

// Per-task serialization for read-modify-write. updateTask reads the row from
// IDB, merges the caller's partial `updates`, and writes it back. Two rapid
// updates to the same id (e.g. setting a title then immediately marking done)
// are both async and interleave: the second's getTask can resolve before the
// first's putTask commits, so it reads a stale base and its write clobbers the
// first update (the "create-then-done loses its title" bug). Chaining each id's
// critical section onto the previous one makes the read-merge-write atomic per
// id without blocking unrelated tasks.
const taskWriteChains = new Map()
function withTaskLock(id, fn) {
  const prev = taskWriteChains.get(id) || Promise.resolve()
  const next = prev.then(fn, fn)
  // Keep the chain from growing unbounded: once this link settles and it's
  // still the tail, drop it so a quiescent id holds no retained promise.
  taskWriteChains.set(id, next)
  next.finally(() => {
    if (taskWriteChains.get(id) === next) taskWriteChains.delete(id)
  })
  return next
}

// Re-run pending-audio upload whenever the tab returns to the foreground.
// Firefox-Android (and iOS) have no Background Sync, so an upload interrupted by
// the screen turning off mid-push can't finish in the background — the page is
// frozen. pushPendingAudio derives the pending set from IDB (any local blob
// without a driveFileId), so calling it on visibility-return reliably finishes
// those clips the instant the user reopens the app, instead of leaving them
// stranded until a full re-init. Registered once (guarded) by runInitialSync.
let audioVisibilityHandlerAttached = false
function attachAudioVisibilityReplay(getState) {
  if (audioVisibilityHandlerAttached || typeof document === 'undefined') return
  audioVisibilityHandlerAttached = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    // Skip while permanently offline OR manually paused — no uploads either way.
    if (!getState().driveEnabled) return
    pushPendingAudio().catch(e => console.warn('pushPendingAudio (on resume) failed', e))
  })
}

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
      const res = await withAuthRetry(() =>
        window.gapi.client.request({ path: 'https://www.googleapis.com/oauth2/v3/userinfo' })
      )
      const email = res.result?.email || null
      if (email) set({ userEmail: email })
    } catch {}
  },

  // Manual "go offline" toggle for a Drive-mode user (distinct from MODE_OFFLINE,
  // which is the permanent no-Drive choice made at login). While paused, local
  // writes keep landing in IDB but nothing is pushed and the poll engine is
  // stopped — useful for working offline on the go. Resuming flushes whatever
  // changed and restarts polling. PERSISTED (SYNC_PAUSED_KEY): a reopen stays
  // paused until the user explicitly resumes — App boot reads the flag and skips
  // the background Drive connect when set.
  syncPaused: false,

  // Helper: should we push to Drive? False in permanent offline mode AND while
  // the user has manually paused sync. Every push call site routes through this.
  get driveEnabled() {
    return get().mode !== MODE_OFFLINE && !get().syncPaused
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
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    }
    // A contentless card (the "+" button) is a DRAFT: in-memory only, never
    // written to IDB or pushed. It becomes real on the first updateTask that
    // gives it content (title, explanation, …) — updateTask strips the flag
    // and persists. A draft abandoned blank is simply forgotten
    // (discardDraftTask), so no blank task ever exists in IDB/Drive and there
    // is nothing to auto-delete — the source of the "created task vanished
    // then reappeared" bugs.
    const isDraft = !(title?.trim() || explanation?.trim())
    if (isDraft) task.draft = true
    else await putTask(task)
    logSync('addTask', { id: task.id.slice(0, 8), hasTitle: !!task.title, status: task.status, draft: isDraft })
    set(s => ({ tasks: [...s.tasks, task] }))
    if (!isDraft && get().driveEnabled) withRetry(pushTasks)()
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
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    }
    // Same draft semantics as addTask.
    const isDraft = !(title?.trim() || explanation?.trim())
    if (isDraft) task.draft = true
    else await putTask(task)
    set(s => ({ tasks: [...s.tasks, task] }))
    get().bumpReviewVersion()
    if (!isDraft && get().driveEnabled) withRetry(pushTasks)()
    return task
  },
  updateTask: async (id, updates) => withTaskLock(id, async () => {
    // Base the merge on IDB, not the store. The store can lag behind a sync
    // poll by a tick; using a stale store snapshot here would re-pin stale
    // fields (status, doneDate, …) on top of the user's `updates` and push
    // them back to Drive, clobbering edits from the other device.
    //
    // The getTask→putTask below is serialized per id by withTaskLock so two
    // rapid updates to the same task can't interleave and lose each other's
    // fields (the create-then-done title-loss bug).
    const fromDb = await getTask(id)
    const fallback = get().tasks.find(t => t.id === id)
    const task = fromDb || fallback
    if (!task) return
    // The first write of a draft strips the in-memory flag — this putTask is
    // what turns a draft into a real, persisted task.
    const { draft, ...updated } = { ...task, ...updates, updatedAt: new Date().toISOString() }
    await putTask(updated)
    logSync('updateTask', {
      id: id.slice(0, 8),
      from: fromDb ? 'db' : (fallback ? 'store' : 'none'),
      baseHasTitle: !!task.title,
      updHasTitle: !!updated.title,
      updates: Object.keys(updates),
      status: updated.status,
      ...(draft ? { wasDraft: true } : {}),
    })
    set(s => ({ tasks: s.tasks.map(t => t.id === id ? updated : t) }))
    get().bumpReviewVersion()
    if (get().driveEnabled) withRetry(pushTasks)()
  }),
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
  deleteTask: async (id) => withTaskLock(id, async () => {
    // A still-draft task was never persisted — nothing to tombstone, just
    // forget it.
    const storeRow = get().tasks.find(t => t.id === id)
    if (storeRow?.draft) {
      logSync('deleteTask', { id: id.slice(0, 8), draft: true })
      set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
      get().bumpReviewVersion()
      return
    }
    // Keep display fields on the tombstone so Trash can show the task without
    // re-hydrating content. Title/createdAt survive; everything else is fine
    // to drop. Status is preserved so we can skip done/reviewed tasks in Trash.
    //
    // Locked + IDB-based for the same reason as updateTask: an unlocked
    // store-snapshot tombstone can interleave with an in-flight updateTask
    // putTask, and whichever write lands second silently wins the row.
    const existing = (await getTask(id)) || storeRow
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
    logSync('deleteTask', { id: id.slice(0, 8), hadTitle: !!existing?.title, status: tomb.status || null })
    set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
    get().bumpReviewVersion()
    if (get().driveEnabled) withRetry(pushTasks)()
  }),
  // Abandoning a card that still looks blank. Only ever removes a DRAFT —
  // a real (persisted) task is never deleted by this path. Locked so it
  // queues behind an in-flight updateTask from the same gesture (a title
  // blur commits via async updateTask while the caller's render closure
  // still reads an empty title — the "created task vanished then
  // reappeared" race); once that write lands the draft flag is gone and
  // this no-ops.
  discardDraftTask: async (id) => withTaskLock(id, async () => {
    const row = get().tasks.find(t => t.id === id)
    logSync('discardDraftTask', { id: id.slice(0, 8), stillDraft: !!row?.draft, hasRow: !!row })
    if (!row?.draft) return
    set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
    get().bumpReviewVersion()
  }),
  reorderTasks: (orderedIds) => {
    const tasks = get().tasks
    const now = new Date().toISOString()
    const changed = []
    const updated = tasks.map(t => {
      const idx = orderedIds.indexOf(t.id)
      if (idx === -1) return t
      if (t.order === idx) return t
      const next = { ...t, order: idx, updatedAt: now }
      changed.push(next)
      return next
    })
    if (changed.length === 0) return
    // Probe: which ids got a new order, and to what. `order` here is the index
    // within the (filtered) view that produced `orderedIds`, so two devices with
    // different visible subsets can stamp divergent orders for the same id — the
    // suspected "order stale on the other device" cause. Logs the write so the
    // next merge log (mergeTaskDocs CHANGED local: localOrder/mergedOrder) can be
    // paired against what was actually pushed.
    logSync('reorderTasks', {
      orderedIds: orderedIds.map(id => id.slice(0, 8)),
      changed: changed.map(t => ({ id: t.id.slice(0, 8), order: t.order })),
    })
    set({ tasks: updated })
    // Drafts keep their new order in memory only; it persists with the draft
    // itself on the first content commit (updateTask).
    const persistable = changed.filter(t => !t.draft)
    if (persistable.length === 0) return
    putTasks(persistable).then(() => {
      if (get().driveEnabled) withRetry(pushTasks)()
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
    if (get().driveEnabled) withRetry(pushNotes)()
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
    if (get().driveEnabled) withRetry(pushNotes)()
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
    if (get().driveEnabled) withRetry(pushNotes)()
  },

  // Journals (per-day docs keyed by date YYYY-MM-DD).
  // currentDay shape: { date, blocks, reviewedAt, blockComments, createdAt, updatedAt }
  currentDay: null,
  // Monotonic counter bumped ONLY when currentDay changes from an external
  // origin — navigation/load, a sync-poll merge, or an audio restore. The
  // editor's own debounced save also writes currentDay (so other readers see
  // fresh blocks) but deliberately does NOT bump this. JournalPanel keys its
  // re-render effect on this counter, so it never reacts to the echo of its
  // own save — which is what rebuilt the doc mid-type and caused typing lag.
  currentDayRev: 0,
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
    const key = date ? dayKey(date) : currentJournalDay(get().config)
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
    let config = get().config || {}

    // First-device seeding: if no rollover preference has ever been written,
    // adopt this device's timezone with 04:00 as the boundary. Drive sync
    // will propagate the chosen defaults to subsequent devices.
    if (config.dayRolloverZone == null && config.dayRolloverHour == null) {
      const seeded = {
        ...config,
        dayRolloverZone: detectBrowserTimezone(),
        dayRolloverHour: 4,
      }
      await putConfigWithDoc(seeded, null)
      set({ config: seeded })
      if (get().driveEnabled) withRetry(pushConfig)()
      config = seeded
    }

    const t = currentJournalDay(config)

    // Daily rollover maintenance (only when loading today).
    if (key === t && config.autoDismissCompletedNextDay && config.autoDismissCompletedLastRunDate !== t) {
      const now = new Date().toISOString()
      const currentTasks = get().tasks
      const changed = []
      const updatedTasks = currentTasks.map(task => {
        if (task.status === 'done' && task.doneDate && task.doneDate < t) {
          const next = { ...task, status: 'dismissed', dismissedDate: t, updatedAt: now }
          changed.push(next)
          return next
        }
        return task
      })
      if (changed.length > 0) {
        await putTasks(changed)
        set({ tasks: updatedTasks })
        get().bumpReviewVersion()
        if (get().driveEnabled) withRetry(pushTasks)()
      }

      const nextConfig = { ...config, autoDismissCompletedLastRunDate: t }
      await putConfigWithDoc(nextConfig, null)
      set({ config: nextConfig })
      if (get().driveEnabled) withRetry(pushConfig)()
    }

    // Show the locally-stored doc immediately so the editor doesn't flash empty
    // while we wait on a network round-trip. The merge below will update
    // currentDay again if Drive had newer content. External origin (navigation)
    // → bump rev so the editor renders it. Capture this exact object reference:
    // it's our "did the user edit while the merge was in flight?" sentinel. If
    // currentDay is replaced during the await — by the editor's debounced
    // updateJournalEntry (which sets a NEW currentDay object that already
    // contains the keystrokes AND ran its own merge+push) — then our `merged`
    // here was computed from a pre-edit snapshot and is stale. Overwriting
    // currentDay with it would clobber the just-typed text (the "edit in the
    // first few secs gets deleted, reappears on refresh" bug). So we only adopt
    // `merged` when the reference is unchanged.
    const optimistic = doc
    set(s => ({ currentDay: optimistic, currentDayRev: s.currentDayRev + 1 }))
    if (doc.reviewedAt) {
      const nextReviews = { ...get().reviews, [doc.date]: doc.reviewedAt }
      set({ reviews: nextReviews })
    }

    if (get().driveEnabled) {
      const merged = await mergeAndPushJournal(doc).catch(() => null)
      if (merged) {
        doc = merged
        await putJournal(doc)
        // Adopt the merge result only if the user has NOT edited since we
        // showed the optimistic doc. Reference identity is the test: a typed
        // edit's debounced save replaces currentDay with a fresh object, so
        // `shown !== optimistic` means edits are in flight and `merged` is
        // stale — leave the live (edited) doc alone; its own push carries it.
        const shown = get().currentDay
        const userEditedSinceLoad = shown !== optimistic
        if (!userEditedSinceLoad && shown?.date === doc.date) {
          // No in-flight edit. Re-set only when content actually differs, so
          // an identical merge doesn't churn a fresh reference and re-fire
          // JournalPanel's reconcile effect for nothing (the stale-then-flick).
          const changed =
            blocksToHtml(shown.blocks) !== blocksToHtml(doc.blocks) ||
            (shown.reviewedAt || null) !== (doc.reviewedAt || null)
          if (changed) set(s => ({ currentDay: doc, currentDayRev: s.currentDayRev + 1 }))
        }
        if (!userEditedSinceLoad && doc.reviewedAt) {
          const nextReviews = { ...get().reviews, [doc.date]: doc.reviewedAt }
          set({ reviews: nextReviews })
        }
        // The Today gate (SurfaceLoadingGate bucket="today") tracks JOURNAL
        // readiness, which is exactly this merge. Lift it only on SUCCESS:
        // during warm boot the first loadJournal runs before Drive is
        // initialized, so its merge fails — marking ready there lifted the
        // gate on stale local data, defeating the gate entirely. On failure
        // the gate is lifted by runInitialSync's done/error handlers (or the
        // post-connect loadJournal that runs once Drive is ready).
        get().markSyncReady('today')
        return doc
      }
    } else {
      get().markSyncReady('today')
    }

    await putJournal(doc)
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
    if (get().driveEnabled) {
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
    if (get().driveEnabled) {
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
    if (get().driveEnabled) withRetry(() => pushJournal(updated))()
  },

  // Audio (local-first, lazy Drive sync). Metadata (driveFileId, transcript,
  // etc.) lives on the document node — see AudioNode.jsx. IDB holds the blob
  // (the only thing that can't live in the CRDT). saveAudioBlob writes the blob
  // and kicks off the Drive upload; once the upload resolves we hand the
  // resulting driveFileId back via onUploaded so the caller can stamp it onto
  // the freshly-inserted node, making the doc reference self-sufficient.
  saveAudioBlob: async (blob, duration = 0, onUploaded = null) => {
    const id = uuid()
    const mimeType = blob.type || 'audio/webm'
    const createdAt = new Date().toISOString()
    await putAudio({ id, blob, mimeType, duration, createdAt })
    if (get().driveEnabled) {
      ;(async () => {
        try {
          const driveFileId = await pushAudio(id)
          if (driveFileId && typeof onUploaded === 'function') onUploaded(driveFileId)
        } catch (e) {
          console.warn('audio upload failed (pushPendingAudio will retry)', e)
        }
      })()
    }
    return { id, mimeType, createdAt }
  },
  // hints: { driveFileId, mimeType, duration, createdAt } from the node.
  // opts.metaOnly: skip the blob download (used for legacy-transcript backfill).
  getAudioRecord: async (id, hints = null, opts = null) => {
    if (get().mode === MODE_OFFLINE) return getAudio(id)
    return ensureAudioLocal(id, hints, opts)
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
    if (get().driveEnabled) withRetry(pushTasks)()
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
    if (get().driveEnabled) withRetry(pushNotes)()
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
    const audioHtml = audioBlockHtml(rec)
    // Block id MUST equal the data-bid baked into audioHtml (audio-<clipId>), so
    // the Automerge list identity and the html identity agree — otherwise a
    // re-parse on another device mints a different id and the clip duplicates.
    const newBlock = { id: `audio-${rec.id}`, html: audioHtml, updatedAt: now }
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
      if (get().driveEnabled) withRetry(pushNotes)()
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
      set(s => (s.currentDay?.date === date ? { currentDay: updatedDoc, currentDayRev: s.currentDayRev + 1 } : {}))
      if (get().driveEnabled) withRetry(() => pushJournal(updatedDoc))()
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
    if (get().driveEnabled) withRetry(pushTasks)()
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
    if (get().driveEnabled) withRetry(pushNotes)()
  },

  // Config
  config: {},
  loadConfig: async () => {
    const config = await getConfig()
    set({ config: config || {} })
  },
  updateConfig: async (updates) => {
    const config = { ...get().config, ...updates }
    // putConfigWithDoc marks the config entity dirty (offline → just local).
    // pushConfig (wrapped in withRetry) drains the dirty flag and ships the
    // Automerge doc; the write-generation bump guards against an in-flight poll
    // clobbering this edit.
    await putConfigWithDoc(config, null)
    set({ config })
    if (get().driveEnabled) withRetry(pushConfig)()
  },

  // Sync (Drive mode only)
  syncing: false,
  lastSync: null,
  syncStatus: { state: 'offline' }, // { state: 'synced'|'syncing'|'offline'|'waiting', retryIn?: number }
  // Cold-pull progress shown in the boot overlay + surface gates. `active` is
  // true while the initial cold-start enumeration is running on a fresh device.
  // `progress` maps bucket label → { current, total } for the most recent
  // batch tick of that bucket.
  coldPull: { active: false, progress: {} },
  setColdPull: (next) => set({ coldPull: next }),
  // Per-surface gates. False during initial connect; flipped true as each
  // staged-pull bucket resolves. Once true they stay true — incremental polls
  // are cheap and merge-safe via writeGeneration, no need to re-gate.
  // Offline mode: everything is immediately ready since there's no Drive merge.
  syncReady: { today: false, journals: false, tasks: false, notes: false, audio: false, config: false },
  markSyncReady: (bucket) => set(s => ({
    syncReady: { ...s.syncReady, [bucket]: true },
  })),
  markAllSyncReady: () => set({
    syncReady: { today: true, journals: true, tasks: true, notes: true, audio: true, config: true },
  }),
  setSyncStatus: (s) => {
    if (s.isAuth) {
      // Tear the engine down before mutating state so the next poll tick
      // can't race the status update and reset us back to 'syncing'.
      try { stopSyncEngine() } catch {}
      set({
        syncStatus: s,
        syncing: false,
        initError: s.message || 'Session expired. Please sign in again.',
        // Drop back to the login screen so the user can actually re-auth.
        // Otherwise we'd sit on the app shell forever with a dead token.
        isAuthenticated: false,
      })
      return
    }
    // While manually paused, ignore engine-emitted status. A poll that was
    // already in flight when the user paused can resolve afterward and emit
    // 'synced'/'syncing', which would flicker the dot back on and contradict the
    // 'offline' we set. The toggle owns the status while paused.
    if (get().syncPaused) return
    set({ syncStatus: s, syncing: s.state === 'syncing' })
  },
  /**
   * Manual offline toggle for a Drive-mode user. Clicking the sync status text
   * pauses (work fully local, no pushes/polls), clicking again resumes (flush +
   * re-poll). No-op for permanent MODE_OFFLINE users — they have no engine to
   * stop and nothing to resume to.
   *
   * Pause: stopSyncEngine() drains cleanly — any in-flight push/poll finishes on
   * its own (executePush/pollRemote aren't aborted mid-flight; we just stop
   * scheduling new ones and drop listeners), then it sets status 'offline'.
   * Because driveEnabled now also checks syncPaused, every subsequent local edit
   * lands in IDB + dirty set but issues no push.
   *
   * Resume: flip the flag first (so flushPendingSync's pushes pass driveEnabled),
   * flush everything that piled up, then restart the engine to resume polling.
   */
  toggleSyncPause: async () => {
    if (get().mode === MODE_OFFLINE) return
    const pausing = !get().syncPaused
    if (pausing) {
      set({ syncPaused: true })
      // Persist so a reopen stays offline until the user resumes.
      putMeta(SYNC_PAUSED_KEY, true).catch(() => {})
      try { stopSyncEngine() } catch {}
      // stopSyncEngine sets status 'offline'; make it explicit + stop the spinner.
      set({ syncStatus: { state: 'offline' }, syncing: false })
      return
    }

    // Resuming. PULL BEFORE PUSH: if another device changed the same entities
    // while we were paused, we must merge its state into our local Automerge
    // docs FIRST, then push. Push-first would still CRDT-merge (push* read the
    // remote .bin), but pull-first is what makes last-write-wins scalar fields
    // (task status/doneDate, note title, config values) resolve correctly and
    // gets the other device's changes onto our screen before we upload.
    set({ syncPaused: false, syncStatus: { state: 'syncing' }, syncing: true })
    putMeta(SYNC_PAUSED_KEY, false).catch(() => {})

    // Restart the poll engine first so pullNow has a running engine + storeSetter.
    // The onSyncStatus listener registered at boot survives stopSyncEngine (it
    // only clears timers, not the listener Set), so we must NOT re-add it here or
    // setSyncStatus would fire twice per status change.
    const intervalMs = (get().config?.syncInterval || 1) * 1000
    startSyncEngine((data) => set(data), intervalMs, () => get())

    try {
      // 1. Pull: drain remote changes into local docs + the store.
      await pullNow()
      // 2. Push: flush everything that piled up locally while paused. Routed
      //    through withRetry so it bumps writeGeneration (concurrent interval
      //    polls discard their in-flight results) and joins the engine's
      //    single-flight push coalescing — no direct push racing a poll. Each
      //    push re-merges against the now-current remote .bin, so it can't
      //    clobber what we just pulled.
      await withRetry(flushPendingSync)()
      await pushPendingAudio().catch(e => console.warn('resume: pushPendingAudio', e))
    } catch (e) {
      console.warn('resume pull/flush failed', e)
    }
    // Kick a final poll so the dot settles to 'synced' and any change our push
    // produced is reflected. The engine's interval polling carries on from here.
    retryNow()
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

    const onProgress = (evt) => {
      if (!evt) return
      if (evt.phase === 'cold-start-begin') {
        set({ coldPull: { active: true, progress: {} } })
      } else if (evt.phase === 'cold-start-progress') {
        set(s => ({
          coldPull: {
            active: true,
            progress: { ...(s.coldPull?.progress || {}), [evt.label]: { current: evt.current, total: evt.total } },
          },
        }))
      } else if (evt.phase === 'cold-start-done') {
        set({ coldPull: { active: false, progress: {} } })
      }
    }

    let handle
    try {
      handle = initialSyncStreaming(onProgress)
    } catch (e) {
      // Synchronous failure to even start the merge — fall back to local reads.
      console.error('Sync failed to start', e)
      const [tasks, notes, config] = await Promise.all([getTasks(), getNotes(), getConfig()])
      set({ tasks, notes, config: config || {}, lastSync: Date.now() })
      set({ syncing: false, syncStatus: { state: 'offline' } })
      // Sync never started — no journal merge will run. Lift every gate so the
      // editor isn't frozen behind a spinner that can never clear.
      get().markAllSyncReady()
      await get().rebuildReviewsFromJournals().catch(() => {})
      return
    }

    // NOTE: the `today` gate is marked ready by loadJournal once its per-day
    // journal merge settles — NOT here. The streaming `today` bucket only
    // resolves config (see sync.js Stage 1), so marking it ready here would lift
    // the Today gate before the journal merge finishes and re-open the
    // edit-clobber race. We still consume the bucket promise for its side
    // effects, but the real "today ready" signal is loadJournal's.
    handle.buckets.today.catch(() => {})
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
      get().markSyncReady('config')
    }).catch(() => { get().markSyncReady('config') })

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
        // Past-journals readiness (Stage 4 + reviews rebuilt). Review and Search
        // read ALL historical journal days + `reviews`, both current only now —
        // distinct from `today` (just today's single day). Mark it here, after
        // rebuildReviewsFromJournals, so the Review gate lifts with correct data.
        get().markSyncReady('journals')
        // Safety net for the `today` gate when the user did NOT land on Today.
        // loadJournal (JournalPanel mount) is the primary signal, but it only
        // runs on the Today route. By now the full merge is done, so `today` is
        // genuinely ready too. Idempotent with loadJournal's own mark.
        get().markSyncReady('today')
      })().catch(() => { get().markSyncReady('journals'); get().markSyncReady('today') })

      set({ lastSync: Date.now(), syncing: false, coldPull: { active: false, progress: {} } })

      onSyncStatus((s) => {
        useAppStore.getState().setSyncStatus(s)
      })
      const intervalMs = (result?.mergedConfig?.syncInterval || 1) * 1000
      startSyncEngine((data) => set(data), intervalMs, () => get())
      pushPendingAudio().catch(e => console.warn('pushPendingAudio failed', e))
      attachAudioVisibilityReplay(get)
      get().loadJournalTagPool()
    }).catch((e) => {
      console.error('Sync failed', e)
      const code = e?.status || e?.result?.error?.code
      const isAuth = code === 401 || code === 403
      if (isAuth) {
        get().setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
      } else {
        set({ syncStatus: { state: 'offline' } })
      }
      // Don't keep surfaces gated if the merge bailed — local data is still
      // viewable; the next poll will hydrate fresh remote data.
      get().markAllSyncReady()
      set({ coldPull: { active: false, progress: {} } })
      // Only spin up the poll engine when auth is healthy. With a dead token
      // the engine would just loop pollRemote every second, briefly setting
      // status back to 'syncing' on each tick and producing the
      // never-clearing spinner the user sees. The user must re-login first.
      if (!isAuth) {
        onSyncStatus((s) => {
          useAppStore.getState().setSyncStatus(s)
        })
        startSyncEngine((data) => set(data), 1000, () => get())
      }
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
    if (get().mode === MODE_OFFLINE) {
      // No Drive merge to wait on — every surface is immediately editable.
      get().markAllSyncReady()
    }
    // Drive mode reuses this as the warm-boot local preload. Gates stay DOWN:
    // the data just loaded is a stale local snapshot, and lifting the gates
    // here is what let the user type over data the first merge hadn't landed
    // yet. runInitialSync / loadJournal lift each bucket as its merge settles
    // (with markAllSyncReady fallbacks on every connect-failure path).
    await get().rebuildReviewsFromJournals().catch(() => {})
    get().loadJournalTagPool()
  },
}))

export { retryNow, stopSyncEngine, setPollInterval }
export default useAppStore
