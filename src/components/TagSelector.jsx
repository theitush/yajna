import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import React from 'react'

const TagChip = ({ tag, onRemove }) => {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 6px',
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border-light)',
      borderRadius: '12px',
      fontSize: '11px',
      color: 'var(--accent)',
      fontWeight: 500,
      fontFamily: 'var(--font-body)',
    }}>
      #{tag}
      <button
        onClick={(e) => { e.preventDefault(); onRemove(tag) }}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          fontSize: '12px',
          lineHeight: 1,
          padding: '0',
          margin: '0 -2px 0 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '12px',
          height: '12px',
        }}
        aria-label={`Remove ${tag} tag`}
      >
        ×
      </button>
    </span>
  )
}

const TagSelector = React.forwardRef(({ value, onChange, allTags, placeholder = "Add tags...", onCommit }, ref) => {
  const [inputValue, setInputValue] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef(null)
  const containerRef = useRef(null)

  // Parse current tags from value (space/comma separated hashtags)
  const currentTags = useMemo(() => {
    if (!value) return []
    const tags = value.split(/[\s,]+/).filter(tag => tag.startsWith('#') && tag.length > 1)
    return [...new Set(tags.map(tag => tag.slice(1)))] // Remove # and deduplicate
  }, [value])

  // Filter suggestions based on input
  const suggestions = useMemo(() => {
    if (!inputValue.trim()) return allTags.filter(tag => !currentTags.includes(tag)).slice(0, 10)
    const filtered = allTags
      .filter(tag => tag.includes(inputValue) && !currentTags.includes(tag))
      .slice(0, 10)
    // Add option to create new tag if input doesn't match existing
    const exactMatch = allTags.some(tag => tag === inputValue.trim())
    if (inputValue.trim() && !exactMatch && !currentTags.includes(inputValue.trim())) {
      filtered.push(inputValue.trim()) // Add at end as "create new"
    }
    return filtered
  }, [inputValue, allTags, currentTags])

  const updateValue = useCallback((newTags) => {
    const tagString = newTags.map(tag => `#${tag}`).join(' ')
    onChange({ target: { value: tagString } })
  }, [onChange])

  const addTag = useCallback((tag) => {
    if (!tag.trim() || currentTags.includes(tag.trim())) return
    const newTags = [...currentTags, tag.trim()]
    updateValue(newTags)
    setInputValue('')
    setShowSuggestions(false)
    setActiveIndex(-1)
  }, [currentTags, updateValue])

  const removeTag = useCallback((tagToRemove) => {
    const newTags = currentTags.filter(tag => tag !== tagToRemove)
    updateValue(newTags)
  }, [currentTags, updateValue])

  const handleInputChange = (e) => {
    const value = e.target.value
    // Only allow characters valid for hashtags (letters, numbers, underscores, hyphens)
    const sanitized = value.replace(/[^\p{L}\p{N}_-]/gu, '')
    setInputValue(sanitized)
    setShowSuggestions(true)
    setActiveIndex(-1)
  }

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0) {
        addTag(suggestions[activeIndex])
      } else if (inputValue.trim()) {
        addTag(inputValue.trim())
      }
    } else if (e.key === 'Tab') {
      if (showSuggestions && suggestions.length > 0) {
        e.preventDefault()
        const indexToUse = activeIndex === -1 ? 0 : activeIndex
        addTag(suggestions[indexToUse])
      }
      // If the dropdown is closed, allow normal Tab behavior to move focus out.
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => i === -1 ? 0 : (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => i === -1 ? suggestions.length - 1 : (i - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setActiveIndex(-1)
    } else if (e.key === 'Backspace') {
      if (!inputValue && currentTags.length > 0) {
        e.preventDefault()
        removeTag(currentTags[currentTags.length - 1])
      }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onCommit?.()
    } else if (e.key === ',') {
      e.preventDefault()
      if (inputValue.trim()) {
        addTag(inputValue.trim())
      }
    }
  }

  const handleInputFocus = () => {
    setShowSuggestions(true)
  }

  const handleInputBlur = () => {
    // Delay hiding suggestions to allow clicks
    setTimeout(() => setShowSuggestions(false), 150)
  }

  const handleSuggestionClick = (tag) => {
    addTag(tag)
    inputRef.current?.focus()
  }

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Scroll active suggestion into view
  useEffect(() => {
    if (showSuggestions && suggestions.length > 0 && activeIndex >= 0) {
      const activeElement = containerRef.current?.querySelector(`[data-index="${activeIndex}"]`)
      if (activeElement) {
        activeElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [activeIndex, showSuggestions, suggestions.length])

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
        alignItems: 'center',
        minHeight: '32px',
        padding: '4px 8px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-light)',
        borderRadius: '8px',
        fontFamily: 'var(--font-body)',
      }}>
        {currentTags.map(tag => (
          <TagChip key={tag} tag={tag} onRemove={removeTag} />
        ))}
        <input
          ref={(el) => {
            inputRef.current = el
            if (ref) ref.current = el
          }}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          placeholder={currentTags.length === 0 ? placeholder : ""}
          style={{
            flex: 1,
            minWidth: '100px',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--accent)',
            fontSize: '12px',
            fontWeight: 500,
            fontFamily: 'var(--font-body)',
            padding: '2px 0',
          }}
        />
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-mid)',
          borderRadius: '8px',
          padding: '4px',
          zIndex: 30,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          maxHeight: '200px',
          overflowY: 'auto',
        }}>
          {suggestions.map((tag, index) => (
            <button
              key={tag}
              data-index={index}
              onClick={() => handleSuggestionClick(tag)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '6px',
                background: index === activeIndex && activeIndex >= 0 ? 'var(--bg-tertiary)' : 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              {tag === inputValue.trim() && inputValue.trim() && !allTags.some(t => t === inputValue.trim())
                ? `Create "#${tag}"`
                : `#${tag}`
              }
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

TagSelector.displayName = 'TagSelector'

export default TagSelector