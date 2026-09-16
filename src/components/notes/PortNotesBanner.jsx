/**
 * "N notes need a tag" — the one-time, user-driven review that ports
 * pre-bijection notes to tag titles (#35). Sits at the top of the Notes list
 * only while some note still needs one; disappears when none is left. Apply is
 * blocked until every row is a valid, unique, unclaimed tag. Touches note rows
 * only — never a journal day.
 */
import { useMemo, useState } from 'react'
import { needsTag, planPort } from './portNotes'

export default function PortNotesBanner({ notes, updateNote }) {
  const [open, setOpen] = useState(false)
  const [edits, setEdits] = useState({})
  const [applying, setApplying] = useState(false)

  const pending = useMemo(() => notes.filter(needsTag), [notes])
  const { rows, ready } = useMemo(() => planPort(pending, notes, edits), [pending, notes, edits])

  if (pending.length === 0) return null

  const apply = async () => {
    if (!ready || applying) return
    setApplying(true)
    try {
      for (const r of rows) {
        const note = pending.find(n => n.id === r.id)
        await updateNote(r.id, { title: r.tag, formerTitle: note?.title || '' })
      }
      setEdits({})
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="port-banner">
      <button type="button" className="port-banner-head" onClick={() => setOpen(o => !o)}>
        <span>{pending.length} {pending.length === 1 ? 'note needs' : 'notes need'} a tag</span>
        <span className="port-banner-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="port-banner-body">
          <p className="port-banner-hint">
            Every note is a #tag now. Check the tag each one gets, then apply.
          </p>
          {rows.map(r => (
            <div key={r.id} className="port-row">
              <p className="port-row-label" title={r.label}>{r.label}</p>
              <div className="port-row-edit">
                <span className="tag-row-hash">#</span>
                <input
                  value={r.value}
                  onChange={e => setEdits(prev => ({ ...prev, [r.id]: e.target.value }))}
                  placeholder="tag"
                  spellCheck={false}
                  className={r.problem ? 'port-row-input port-row-input-bad' : 'port-row-input'}
                />
              </div>
              {r.problem && <p className="port-row-problem">{r.problem}</p>}
            </div>
          ))}
          <button
            type="button"
            className="port-banner-apply"
            disabled={!ready || applying}
            onClick={apply}
          >
            {applying ? 'Applying…' : `Apply ${rows.length === 1 ? '' : `to ${rows.length} notes`}`.trim()}
          </button>
        </div>
      )}
    </div>
  )
}
