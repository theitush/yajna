import useAppStore from '../../store/useAppStore'

/**
 * Non-dismissable overlay shown while a Phase B sync bucket is still loading.
 * Blocks editing on the surface — a stale read-only view is fine, but writes
 * to a partially-hydrated surface could clobber data we haven't merged yet.
 *
 * Usage: `<SurfaceLoadingGate bucket="tasks">{page contents}</SurfaceLoadingGate>`
 * Pass an array to gate on several buckets — the overlay stays up until EVERY
 * listed bucket is ready (e.g. Review reads+writes both journals and tasks):
 * `<SurfaceLoadingGate bucket={['today', 'tasks']}>…`
 * Once the bucket(s) are ready it renders children with no overlay.
 */
export default function SurfaceLoadingGate({ bucket, children, label }) {
  const buckets = Array.isArray(bucket) ? bucket : [bucket]
  const ready = useAppStore(s => buckets.every(b => s.syncReady?.[b]))
  const coldPull = useAppStore(s => s.coldPull)
  // Cold-pull progress sub-label tracks the first listed bucket (good enough —
  // it's just a "pulling X from Drive" hint, not load-bearing).
  const primary = buckets[0]
  const bucketLabel = primary === 'tasks' ? 'tasks' : primary === 'notes' ? 'notes' : primary
  const bucketProgress = coldPull?.active ? coldPull.progress?.[bucketLabel] : null
  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {children}
      {!ready && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: 'rgba(0,0,0,0.25)',
            backdropFilter: 'blur(1.5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'all',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, maxWidth: 280, textAlign: 'center', padding: '0 16px' }}>
            <div style={{ width: 18, height: 18, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            {coldPull?.active ? (
              <>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>
                  First-time setup
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                  Pulling {bucketLabel} from Drive…
                  {bucketProgress ? ` ${bucketProgress.current}/${bucketProgress.total}` : ''}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)' }}>
                {label || `Loading ${buckets.join(' + ')}...`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
