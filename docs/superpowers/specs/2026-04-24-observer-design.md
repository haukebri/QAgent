# observer.js — design

Date: 2026-04-24
Status: approved, ready for implementation

## Purpose

Turn a Playwright `page` into a compact text snapshot plus a numbered map of selectors pointing to actionable elements. The snapshot is what the LLM reads; the map is what `tools.js` uses to act.

Input: a Playwright `page`.
Output: `{ text, refs }` where `text` is a string and `refs` is an object mapping integer keys to selector strings.

## Why selector strings for refs

`refs[N]` is a Playwright selector string (e.g. `role=link[name="Learn more"]`), not a `Locator` object. String refs are serializable, which means action traces can be saved and replayed later without re-resolving live page objects. `tools.js` does the final `page.locator(refs[N]).click()` step.

## Algorithm

1. Call `page.accessibility.snapshot({ interestingOnly: true })`. Playwright's built-in filter drops pure-layout/generic nodes.
2. Walk the returned tree depth-first.
3. Classify each node's role:
   - **Actionable** → emit `[N] role "name"` line; assign ref `N`; record its selector.
   - **Named context** → emit `role "name"` line; no ref.
   - **Skip** (not in either list and no name) → do not emit, but recurse into children.
4. Indent by depth-in-emitted-tree. Skipped nodes do not add indent, so a page wrapped in many layout generics does not produce a deeply indented snapshot.
5. Join emitted lines with `\n`.

## Role lists (MVP)

**Actionable — get refs:**
`link`, `button`, `textbox`, `checkbox`, `radio`, `combobox`, `switch`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `tab`, `option`, `searchbox`, `slider`, `spinbutton`.

**Named context — text only, no ref:**
`heading`, `paragraph`, `text`, `img`, `list`, `listitem`, `table`, `row`, `cell`, `columnheader`, `rowheader`, `dialog`, `alert`, `status`, `banner`, `navigation`, `main`, `form`, `region`, `article`, `complementary`, `contentinfo`.

Any other role: skip, but recurse into its children.

These lists are intentionally a starting point. They will be revisited as soon as the LLM loop reveals gaps.

## Selector string format

Default: `role=<role>[name="<escaped-name>"]`.

If the same `(role, name)` pair has already been used in this observation, append ` >> nth=<k>` where `k` is the 0-indexed occurrence order (second occurrence is `nth=1`, third is `nth=2`, and so on).

Escape the name for the `[name="..."]` attribute: `\` → `\\`, `"` → `\"`.

## File shape

- `src/observer.js`.
- ES module. Exports exactly one function: `observe(page)`.
- Approximately 80–100 lines.
- Two internal helpers (role classifier, selector builder). Not exported.
- Only Playwright call: `page.accessibility.snapshot()`. Everything else is pure tree walking.

## Example output

For `https://example.com`:

```
heading "Example Domain"
paragraph "This domain is for use in documentation examples without needing permission. Avoid use in operations."
[1] link "Learn more"
```

```js
refs = { 1: 'role=link[name="Learn more"]' }
```

## Out of scope

- Hidden/offscreen filtering beyond `interestingOnly`.
- Stable refs across observations — refs are regenerated each call. The LLM sees a fresh snapshot per turn.
- Output truncation for very large pages.
- Rendering disabled/readonly/checked state in the text.
- Tests. Verification is by eyeballing the output against example.com, news.ycombinator.com, and a form-heavy page.

## Success criterion

Running `observe(page)` on example.com, HN, and one form-heavy page produces a readable text snapshot, a correct refs map, and a noticeable size reduction relative to the raw `ariaSnapshot()` from step 1.
