# Form-filling Tools

## Context

QAgent's tool surface today only covers `click`, `fill`, `navigate`, and `observe`. That's enough for buttons, links, and plain text inputs — but a large slice of real web forms is unreachable:

- **Native `<select>` / `<option>` dropdowns** can't be driven. `fill` doesn't apply to them.
- **ARIA comboboxes with keyboard-driven autocomplete** (type → arrow-down → Enter) have no path forward. Many search boxes, address pickers, and tag inputs work this way.
- **Forms that submit on Enter** (search boxes without a visible submit button) require pressing a key.
- **Modals dismissed by Escape**, focus advanced by **Tab** — none of this is reachable today.
- **Custom inputs that silently swallow `fill()`** (some React-controlled inputs, masked inputs, contenteditable elements) need keyboard typing instead of programmatic value injection.

The LLM is currently forced to give up or fabricate around these gaps, which shows up as `fail` verdicts on goals that a human would breeze through.

---

## Status

[done]

---

## Goals / Scope

- **Select an option** from a native dropdown by visible label.
- **Press a key** — Enter, Escape, Tab, arrow keys — either targeted at an element (focus + press) or as a global keystroke (no ref required, e.g. dismissing a modal).
- **Keyboard-type** a value as an alternative to `fill` when the latter doesn't take.
- Teach the LLM, via prompt heuristics, when to reach for each new tool versus the existing `click` / `fill`.

---

## Open questions

1. **Multi-select (`<select multiple>`)** — support in v1 or defer? Answer: yes included
2. **Modifier-key combos** (`Control+A`, `Shift+Tab`, `Cmd+Enter`) — support in v1 or defer? Answer: NOT included now
3. **Hover** — do we need a `hover` tool for menus that expand on mouseover, or do enough sites have a click fallback that we can defer? Answer: NO hover needed
4. **Direct DOM value injection** (`element.value = "..."`) — defer permanently in favor of keyboard typing, since raw DOM writes bypass React's synthetic event system and are silently ignored by many apps? Answer: Yes do not do direct injections

---

## Out of scope

Drag-and-drop. File upload (`<input type=file>`). Calendar/date-picker widgets (the LLM types ISO strings, which usually works). Iframe traversal. Shadow-DOM piercing beyond what Playwright already does for us.
