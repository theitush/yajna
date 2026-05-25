// Timezone data is pulled live from the browser (Intl.supportedValuesOf
// returns all ~418 IANA zones) and labels are computed — no hardcoded city
// list to maintain.

function offsetMinutes(zone, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(at)
    const raw = parts.find(p => p.type === 'timeZoneName')?.value || ''
    // Shape is "GMT+05:30", "GMT-08:00", or just "GMT".
    const match = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
    if (!match) return 0
    const sign = match[1] === '-' ? -1 : 1
    const h = parseInt(match[2], 10)
    const m = match[3] ? parseInt(match[3], 10) : 0
    return sign * (h * 60 + m)
  } catch {
    return 0
  }
}

function formatOffset(mins) {
  const sign = mins < 0 ? '−' : '+'
  const abs = Math.abs(mins)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`
}

function cityFromZone(zone) {
  // "America/Argentina/Buenos_Aires" → "Buenos Aires"
  const last = zone.split('/').pop() || zone
  return last.replace(/_/g, ' ')
}

function listIanaZones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone')
    }
  } catch { /* fall through */ }
  return ['UTC']
}

// Memoized list of all IANA zones with display metadata. Computed once on
// module load — offsets shift across DST boundaries, but the picker is
// re-rendered rarely enough that staleness doesn't matter for selection.
let _cached = null
export function getAllTimezones() {
  if (_cached) return _cached
  const zones = listIanaZones()
  _cached = zones
    .map(zone => {
      const mins = offsetMinutes(zone)
      return {
        zone,
        city: cityFromZone(zone),
        offsetMinutes: mins,
        offsetLabel: formatOffset(mins),
      }
    })
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city))
  return _cached
}

// Resolve the browser's IANA timezone, falling back to UTC.
export function detectBrowserTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz) return tz
  } catch { /* fall through */ }
  return 'UTC'
}

// Human label for a zone, e.g. "Yerevan (UTC+4)".
export function timezoneLabel(zone) {
  if (!zone) return ''
  const all = getAllTimezones()
  const match = all.find(o => o.zone === zone)
  if (match) return `${match.city} (${match.offsetLabel})`
  return zone
}
