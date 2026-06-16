import { useRef, useLayoutEffect } from 'react'

// Remembers the scroll offset of a scroll region across unmount/remount. React
// Router tears down a route's component tree when you navigate away and rebuilds
// it fresh on return, so a plain ref can't survive — the store lives at module
// scope. Keyed by a caller-supplied string so each region (journal, tasks) is
// tracked independently; pass a falsy key to opt out (e.g. the Review reuse of
// these panels, which keys its own copies by date).
const positions = new Map()

export default function useScrollRestore(key) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !key) return

    const saved = positions.get(key) || 0
    // While we re-apply the saved offset, the element may momentarily be too
    // short to reach it (see below) and clamp to a smaller value — don't let
    // that intermediate value overwrite what we're trying to restore.
    let restoring = saved > 0

    const record = () => { if (!restoring) positions.set(key, el.scrollTop) }
    el.addEventListener('scroll', record, { passive: true })

    let raf = 0
    const endRestore = () => {
      restoring = false
      cancelAnimationFrame(raf)
      el.removeEventListener('wheel', endRestore)
      el.removeEventListener('touchmove', endRestore)
    }

    if (restoring) {
      // The content (TipTap editor DOM / task cards) can mount a frame or two
      // after this layout effect, leaving the container too short to reach the
      // saved offset on the first try. Re-apply across a handful of frames until
      // it sticks — but bail the instant the user scrolls so we never fight a
      // live gesture.
      el.addEventListener('wheel', endRestore, { passive: true })
      el.addEventListener('touchmove', endRestore, { passive: true })
      let frames = 0
      const apply = () => {
        if (!restoring) return
        el.scrollTop = saved
        if (el.scrollTop >= saved - 1 || frames++ >= 30) endRestore()
        else raf = requestAnimationFrame(apply)
      }
      apply()
    }

    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', record)
      el.removeEventListener('wheel', endRestore)
      el.removeEventListener('touchmove', endRestore)
    }
  }, [key])

  return ref
}
