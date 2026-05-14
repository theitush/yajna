import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const TRIGGER_RE = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u
const MAX_ITEMS = 20

function findActiveToken(state) {
  const { $from } = state.selection
  if (!state.selection.empty) return null
  const start = $from.start()
  const before = state.doc.textBetween(start, $from.pos, '\n', '\n')
  const m = before.match(TRIGGER_RE)
  if (!m) return null
  const partial = m[1]
  const tokenStart = $from.pos - partial.length - 1
  return { partial: partial.toLowerCase(), from: tokenStart, to: $from.pos }
}

function createPopup() {
  const el = document.createElement('div')
  el.className = 'hashtag-suggest-popup'
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '9999',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-mid)',
    borderRadius: '8px',
    padding: '4px',
    display: 'none',
    flexDirection: 'column',
    gap: '2px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    minWidth: '140px',
    maxHeight: '220px',
    overflowY: 'auto',
    fontFamily: 'var(--font-body)',
  })
  document.body.appendChild(el)
  return el
}

export const HashtagSuggest = Extension.create({
  name: 'hashtagSuggest',

  addOptions() {
    return { getTags: () => [] }
  },

  addProseMirrorPlugins() {
    const options = this.options

    let popup = null
    let buttons = []
    let items = []
    let active = 0
    let token = null
    let viewRef = null

    const ensurePopup = () => {
      if (!popup) popup = createPopup()
      return popup
    }

    const hide = () => {
      if (popup) popup.style.display = 'none'
      items = []
      buttons = []
      token = null
    }

    const apply = (tag) => {
      const view = viewRef
      if (!view || !token) return
      const tr = view.state.tr.insertText(`#${tag} `, token.from, token.to)
      view.dispatch(tr)
      view.focus()
      hide()
    }

    const updateActiveStyles = () => {
      buttons.forEach((btn, i) => {
        btn.style.background = i === active ? 'var(--bg-tertiary)' : 'transparent'
      })
      const cur = buttons[active]
      if (cur && typeof cur.scrollIntoView === 'function') {
        cur.scrollIntoView({ block: 'nearest' })
      }
    }

    const render = () => {
      const el = ensurePopup()
      el.innerHTML = ''
      buttons = items.map((tag, i) => {
        const btn = document.createElement('button')
        btn.textContent = `#${tag}`
        Object.assign(btn.style, {
          textAlign: 'left',
          fontSize: '12px',
          padding: '6px 10px',
          borderRadius: '6px',
          background: i === active ? 'var(--bg-tertiary)' : 'transparent',
          border: 'none',
          color: 'var(--accent)',
          cursor: 'pointer',
          fontFamily: 'var(--font-body)',
          flexShrink: '0',
        })
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          apply(tag)
        })
        el.appendChild(btn)
        return btn
      })
    }

    const position = (view) => {
      if (!token) return
      let coords
      try { coords = view.coordsAtPos(token.from) } catch { coords = null }
      if (!coords || (coords.left === 0 && coords.top === 0)) { hide(); return }
      const el = ensurePopup()
      el.style.display = 'flex'
      // Render first to measure, then clamp to viewport (visualViewport accounts for mobile keyboard)
      el.style.maxHeight = '220px'
      el.style.left = '0px'
      el.style.top = '0px'
      const vv = window.visualViewport
      const viewportW = vv?.width ?? window.innerWidth
      const viewportH = vv?.height ?? window.innerHeight
      const offsetX = vv?.offsetLeft ?? 0
      const offsetY = vv?.offsetTop ?? 0
      const margin = 8
      const rect = el.getBoundingClientRect()
      const popupW = rect.width
      const popupH = rect.height
      const caretX = coords.left
      const caretBottom = coords.bottom
      const caretTop = coords.top
      // Horizontal: prefer aligning to caret, but clamp inside viewport
      let left = caretX
      const maxLeft = offsetX + viewportW - popupW - margin
      const minLeft = offsetX + margin
      if (left > maxLeft) left = maxLeft
      if (left < minLeft) left = minLeft
      // Vertical: open below if room, else above
      const spaceBelow = (offsetY + viewportH) - caretBottom - margin
      const spaceAbove = caretTop - offsetY - margin
      let top
      let maxH = 220
      if (spaceBelow >= Math.min(popupH, 120) || spaceBelow >= spaceAbove) {
        top = caretBottom + 4
        maxH = Math.max(96, Math.min(220, spaceBelow))
      } else {
        maxH = Math.max(96, Math.min(220, spaceAbove))
        top = caretTop - 4 - Math.min(popupH, maxH)
      }
      el.style.maxHeight = `${maxH}px`
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }

    const update = (view) => {
      viewRef = view
      const tok = findActiveToken(view.state)
      if (!tok) { hide(); return }
      const tags = options.getTags() || []
      const filtered = tok.partial === ''
        ? tags.slice(0, MAX_ITEMS)
        : tags.filter(t => t.startsWith(tok.partial) && t !== tok.partial).slice(0, MAX_ITEMS)
      if (filtered.length === 0) { hide(); return }
      token = tok
      items = filtered
      if (active >= items.length) active = 0
      render()
      position(view)
    }

    return [new Plugin({
      key: new PluginKey('hashtag-suggest'),
      view(editorView) {
        viewRef = editorView
        return {
          update(view) { update(view) },
          destroy() {
            if (popup && popup.parentNode) popup.parentNode.removeChild(popup)
            popup = null
            buttons = []
          },
        }
      },
      props: {
        handleKeyDown(view, event) {
          if (!token || items.length === 0) return false
          if (event.key === 'ArrowDown') {
            active = (active + 1) % items.length
            updateActiveStyles()
            return true
          }
          if (event.key === 'ArrowUp') {
            active = (active - 1 + items.length) % items.length
            updateActiveStyles()
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            apply(items[active])
            return true
          }
          if (event.key === 'Escape') {
            hide()
            return true
          }
          return false
        },
      },
    })]
  },
})
