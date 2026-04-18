import Heading from '@tiptap/extension-heading'

export const HeadingNoShortcut = Heading.extend({
  addInputRules() { return [] },
  addPasteRules() { return [] },
})
