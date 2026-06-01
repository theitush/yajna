import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query and re-render when it flips. Returns the
 * current match as a boolean.
 *
 * Use this to *mount* one layout or the other at a breakpoint, instead of
 * rendering both and hiding one with `hidden`/`md:hidden`. CSS-hiding keeps the
 * hidden subtree fully mounted and running — fine for static markup, but for a
 * stateful component (e.g. a TipTap editor wired to the sync store) the hidden
 * twin stays an active participant in the render loop, doubling work and
 * fighting the visible one.
 */
export default function useMediaQuery(query) {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false

  const [matches, setMatches] = useState(getMatch)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    // Sync once in case the query changed between render and effect.
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

// Tailwind's default `md` breakpoint (768px). Mirrors the `md:` utilities used
// across the app so JS-gated layouts agree with CSS-gated ones.
export const MD_BREAKPOINT = '(min-width: 768px)'
