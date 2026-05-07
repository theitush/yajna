import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Read a "scroll-to / highlight" target from the URL search params and clear
 * it on the next user click anywhere in the page. Returns the active value
 * or null. Pages use this to find and mark a specific item after navigation
 * from search.
 *
 * The marker styling lives in src/index.css under `.search-highlight`.
 */
export default function useHighlightTarget(paramName) {
  const [params, setParams] = useSearchParams()
  const urlValue = params.get(paramName)
  const [target, setTarget] = useState(urlValue)

  useEffect(() => {
    setTarget(urlValue)
  }, [urlValue])

  useEffect(() => {
    if (!target) return
    const clear = () => {
      setTarget(null)
      const current = new URLSearchParams(window.location.hash.split('?')[1] || '')
      if (current.has(paramName)) {
        current.delete(paramName)
        setParams(current, { replace: true })
      }
    }
    // Defer one tick so the click that just navigated us here doesn't clear
    // the marker immediately.
    const timer = setTimeout(() => {
      window.addEventListener('click', clear, { once: true, capture: true })
      window.addEventListener('keydown', clear, { once: true, capture: true })
    }, 50)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('click', clear, { capture: true })
      window.removeEventListener('keydown', clear, { capture: true })
    }
  }, [target, paramName, setParams])

  return target
}
