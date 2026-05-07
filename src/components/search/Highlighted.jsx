import { highlightRanges } from '../../lib/search'

export default function Highlighted({ text, indices, style }) {
  const parts = highlightRanges(text, indices)
  return (
    <span style={style}>
      {parts.map((p, i) => typeof p === 'string'
        ? p
        : (
          <mark
            key={i}
            style={{
              background: 'var(--accent-light, rgba(255,213,79,0.35))',
              color: 'var(--text-primary)',
              padding: '0 1px',
              borderRadius: '2px',
            }}
          >
            {p.text}
          </mark>
        )
      )}
    </span>
  )
}
