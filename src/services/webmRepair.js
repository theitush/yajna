/**
 * Repair MediaRecorder WebM clips whose cluster timestamps jumped.
 *
 * Cause: on some browsers (observed: Brave Android) the recording tab gets
 * suspended right after the first frame. MediaRecorder's clock keeps advancing
 * by wall-clock time while suspended, so the next cluster's base Timestamp leaps
 * by minutes. The muxer then writes that leap as the file's Info > Duration.
 *
 * Symptoms from one defect: bogus duration text (e.g. 87:22 for a 6s clip),
 * "plays forever / no sound", and Groq transcription failing with Internal
 * Server Error (it reads the inflated duration against a short packet stream).
 *
 * Signature of corruption: cluster[0] holds a single priming frame at t=0, then
 * cluster[1]'s base Timestamp is far beyond the steady inter-cluster cadence.
 * Repair: subtract that gap from every cluster after [0] and rewrite Duration
 * from the true last block. Byte-safe — every patched integer is re-encoded at
 * its ORIGINAL field width (zero-padded), so no offsets shift and the Opus
 * payloads are never touched. Healthy clips are returned unchanged.
 */

function readVint(b, p) {
  let len = 1, mask = 0x80
  while (len <= 8 && !(b[p] & mask)) { mask >>= 1; len++ }
  let v = b[p] & (mask - 1)
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i]
  return [v, len]
}

function readId(b, p) {
  let len = 1, mask = 0x80
  while (len <= 4 && !(b[p] & mask)) { mask >>= 1; len++ }
  let h = ''
  for (let i = 0; i < len; i++) h += b[p + i].toString(16).padStart(2, '0')
  return [h, len]
}

function writeUintFixed(b, pos, len, val) {
  for (let i = len - 1; i >= 0; i--) { b[pos + i] = val & 0xff; val = Math.floor(val / 256) }
}

/**
 * Repair the given WebM bytes in place. Returns { changed, durationSec, jumpMs }.
 * `bytes` is a Uint8Array and is mutated when a repair is applied.
 */
export function repairWebmDurationBytes(bytes) {
  const b = bytes
  const [, el] = readId(b, 0)
  const [, esl] = readVint(b, el)
  const clusters = []
  let durPos = null, durLen = 0, scale = 1000000

  function walk(start, end) {
    let p = start
    while (p < end) {
      const [eid, il] = readId(b, p); p += il
      const [size, sl] = readVint(b, p); p += sl
      if (eid === '18538067') { walk(p, p + size); return }       // Segment
      if (eid === '1549a966') { walk(p, p + size) }                // Info
      if (eid === '2ad7b1') { scale = 0; for (let i = 0; i < size; i++) scale = scale * 256 + b[p + i] } // TimestampScale
      if (eid === '4489') { durPos = p; durLen = size }            // Duration (float)
      if (eid === '1f43b675') {                                    // Cluster
        let q = p, tsPos = null, tsLen = 0, ts = null, lastRel = 0, nblocks = 0
        while (q < p + size) {
          const [cid, cil] = readId(b, q); q += cil
          const [cs, csl] = readVint(b, q); q += csl
          if (cid === 'e7') { tsPos = q; tsLen = cs; ts = 0; for (let i = 0; i < cs; i++) ts = ts * 256 + b[q + i] }
          if (cid === 'a3' || cid === 'a1') {                      // SimpleBlock / Block
            nblocks++
            let r = q; const [, tl] = readVint(b, r); r += tl
            const rel = ((b[r] << 8 | b[r + 1]) << 16) >> 16        // signed int16 relative timecode
            if (rel > lastRel) lastRel = rel
          }
          q += cs
        }
        clusters.push({ ts, tsPos, tsLen, lastRel, nblocks })
      }
      p += size
    }
  }
  walk(el + esl, b.length)

  if (clusters.length < 2) return { changed: false }
  const tailSpan = clusters.length >= 3 ? clusters[2].ts - clusters[1].ts : 30000
  // Only repair the suspend-jump shape: priming-only cluster[0] + cluster[1]
  // far beyond cadence. Otherwise it's a healthy file — leave it alone.
  const corrupt = clusters[0].nblocks <= 1 && clusters[1].ts > tailSpan * 3
  if (!corrupt) return { changed: false }

  const jump = clusters[1].ts                                       // rebase so cluster[1] -> 0
  for (let i = 1; i < clusters.length; i++) {
    writeUintFixed(b, clusters[i].tsPos, clusters[i].tsLen, clusters[i].ts - jump)
  }
  const last = clusters[clusters.length - 1]
  const durTicks = (last.ts - jump) + last.lastRel
  if (durPos != null) {
    const dv = new DataView(b.buffer, b.byteOffset + durPos, durLen)
    if (durLen === 8) dv.setFloat64(0, durTicks); else dv.setFloat32(0, durTicks)
  }
  return { changed: true, jumpMs: jump, durationSec: durTicks * scale / 1e9 }
}

/**
 * Repair a Blob if needed. Returns a NEW Blob with the corrected bytes when a
 * repair was applied, or the original Blob unchanged. Non-webm or healthy blobs
 * pass through untouched. Never throws — on any parse error it returns the
 * original so callers can proceed.
 */
export async function repairAudioBlob(blob) {
  if (!blob) return { blob, changed: false }
  const type = blob.type || ''
  if (!/webm|matroska/i.test(type)) return { blob, changed: false }
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const res = repairWebmDurationBytes(bytes)
    if (!res.changed) return { blob, changed: false }
    return { blob: new Blob([bytes], { type: blob.type }), changed: true, durationSec: res.durationSec }
  } catch {
    return { blob, changed: false }
  }
}
