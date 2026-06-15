import { useState, useEffect } from 'react'
import { currentJournalDay } from './dates'

/**
 * The rollover-aware "today" key (YYYY-MM-DD), recomputed when the user
 * returns to the tab.
 *
 * currentJournalDay(config) is correct whenever it RUNS, but it only ran as a
 * side effect of an incidental re-render. A tab left idle/asleep across
 * midnight (or the configured rollover hour) never re-rendered, so the day key
 * stayed frozen on the previous day until some unrelated event (a sync poll
 * merge bumping currentDayRev) happened to force a render. That's why the day
 * "rolled over only after changing the screen and coming back".
 *
 * We make the rollover depend on the events that were already the implicit
 * trigger — returning to the tab — instead of riding on whatever render
 * happened to occur. visibilitychange + focus cover wake-from-sleep and
 * tab-switch; that is the only realistic way an idle laptop crosses a day
 * boundary, so no polling interval is needed.
 */
export default function useCurrentDay(config) {
  const [day, setDay] = useState(() => currentJournalDay(config))

  useEffect(() => {
    // Recompute immediately in case config changed (rollover hour/zone) and on
    // every return-to-tab.
    const recompute = () => setDay(currentJournalDay(config))
    recompute()
    const onVisible = () => {
      if (document.visibilityState === 'visible') recompute()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', recompute)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', recompute)
    }
    // Depend on the rollover fields, not the whole config object (which gets a
    // new identity on every config write and would needlessly re-subscribe).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.dayRolloverZone, config?.dayRolloverHour])

  return day
}
