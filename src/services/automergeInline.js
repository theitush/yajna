/**
 * The journal Automerge ops — the synchronous load→apply/merge→save chains,
 * pure (bytes-in / bytes-out, no DOM, no IDB). Single source of truth shared by
 * BOTH the worker (off-thread, normal case) and the inline fallback (main
 * thread, if the worker can't start). Keeping one copy means the merge/disjoint-
 * root rules can never drift between the two paths.
 *
 * All the disjoint-root / staleness logic moved here VERBATIM from sync.js —
 * only the thread it runs on changed.
 */
import {
  createDoc, loadDoc, saveDoc, mergeDoc, sharesAncestry,
  applyJournalFields, materializeJournalRow,
} from './automergeDoc.js'

// Resolve two disjoint-root docs (no shared ancestry → can't CRDT-merge) by
// recency: newer updatedAt wins, ties to remote so a stale/empty local doc never
// beats fresher remote content (the cross-device staleness heal).
function newerDoc(localDoc, remoteDoc) {
  const lt = new Date(materializeJournalRow(localDoc)?.updatedAt || 0).getTime()
  const rt = new Date(materializeJournalRow(remoteDoc)?.updatedAt || 0).getTime()
  return lt > rt ? localDoc : remoteDoc
}

/**
 * Automerge core of pushJournal — read-MERGE-write. Base-doc selection:
 *   1. our own bytes merged with the remote's (shared ancestry, normal). The
 *      upload REPLACES the only shared copy, so it must be a superset of it:
 *      uploading the local lineage alone erases another device's not-yet-pulled
 *      changes from Drive, and — its dirty token long cleared — that device
 *      never re-pushes them (the 2026-06-11 "laptop's line vanished" loss).
 *      If we DON'T share ancestry, our doc is a disjoint root → reconcile by
 *      recency instead, so we never clobber the canonical remote root.
 *   2. else the remote's bytes (adopt its root → our upload shares ancestry).
 *   3. else first writer → createDoc.
 */
export async function journalApply({ existingBytes, remoteBytes, source }) {
  let doc
  if (existingBytes) {
    doc = await loadDoc(existingBytes)
    if (remoteBytes) {
      const remoteDoc = await loadDoc(remoteBytes)
      doc = (await sharesAncestry(doc, remoteDoc))
        ? await mergeDoc(doc, remoteDoc)
        : newerDoc(doc, remoteDoc)
    }
  } else if (remoteBytes) {
    doc = await loadDoc(remoteBytes)
  } else {
    doc = await createDoc('journal', source)
  }
  doc = await applyJournalFields(doc, source)
  const bytes = await saveDoc(doc)
  const row = materializeJournalRow(doc)
  return { bytes, row }
}

/**
 * Automerge core of mergeJournalDocs' per-day loop. Returns merged bytes + row.
 */
export async function journalMerge({ remoteBytes, localBytes, localRow }) {
  const remoteDoc = await loadDoc(remoteBytes)
  let mergedDoc

  if (localBytes) {
    const localDoc = await loadDoc(localBytes)
    if (await sharesAncestry(localDoc, remoteDoc)) {
      mergedDoc = await mergeDoc(localDoc, remoteDoc)
    } else {
      mergedDoc = newerDoc(localDoc, remoteDoc)
    }
  } else if (localRow) {
    // No local bytes → remote authoritative. Adopt + re-apply local row.
    // NOT createDoc()+merge: disjoint roots drop the remote's blocks.
    mergedDoc = await applyJournalFields(remoteDoc, localRow)
  } else {
    mergedDoc = remoteDoc
  }

  const bytes = await saveDoc(mergedDoc)
  const row = materializeJournalRow(mergedDoc)
  return { bytes, row }
}
