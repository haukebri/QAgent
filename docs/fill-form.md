# `fill_form` Action

## Context

The driver LLM today fills forms one field at a time, picking a `fill` / `selectOption` / `pressKey` action per turn. Across the AIDA-cruise booking goal that's 8–14 turns of pure data entry interleaved with the rest of the booking flow. Three problems show up consistently in the run dataset (`docs/analysis/model-failures.md`):

- **Context bloat.** Each fill turn carries the whole growing snapshot history. By the time the form is finished the prompt is dominated by stale form chatter.
- **Weak models avoid form tools entirely.** Mistral-small never calls `fill` or `selectOption` (0/4 runs). gpt-4.1-nano averages 0.7 fills per multi-step run. Both score 0% on AIDA.
- **Stronger models burn turns.** Even passing runs spend a third of their budget on field-by-field churn that adds no decision value — the LLM is rubber-stamping obvious values, not reasoning.

The proposal is to lift form-filling out of the driver loop entirely and make it a single, fire-and-forget action: the driver hands over a reference to a form, and a sub-routine fills every field inside it in one shot using a focused, narrow LLM prompt that only sees the form sub-tree.

Field-level form tools (other than for plain search-style single inputs) leave the driver's tool surface. The driver no longer chooses when to type "Max Mustermann" into a name box — it only chooses when to invoke the form filler.

---

## Status

[planned]

---

## Goals / Scope

### What `fill_form` must do

- Take a reference to a form-like container (a `<form>`, a fieldset, or any grouping the driver picks).
- Discover every interactive control inside that container — text inputs, native selects, checkboxes, radios, textareas, ARIA comboboxes/checkboxes/radios — in a single deterministic pass, with enough metadata (label, type, required, current value, allowed options) to be useful to a small LLM.
- Decide values for those controls using a separate narrowly-scoped LLM call that sees only the form sub-tree and the run's goal — not the full conversation history.
- Apply the chosen values to the page deterministically. Round-trips to the driver LLM during this step are not allowed.
- Surface, per field, whether it was filled, skipped, or failed — and why. The recorder must end up with enough information that a human reading the trace can see what happened to each field without replaying the run.
- Leave the form in a "ready to submit" state. The driver decides whether and when to submit; `fill_form` never clicks a submit control.
- Return control to the driver loop within a bounded number of internal passes. If the form keeps revealing new fields, give up and let the driver re-invoke.

### What the driver tool surface looks like after this milestone

- `click`, `navigate`, `wait`, `done`, `fail` — unchanged.
- `fill_form` — new.
- `type` and global `pressKey` (no field reference, e.g. global Escape or Enter) — kept, for the rare single-field cases like a homepage search box and for dismissing dialogs.
- `fill`, `selectOption`, and field-level `pressKey` — removed from the driver schema.

### What success looks like (measurable bars before we declare the milestone done)

- **Mistral-small on AIDA-cruise** climbs from 0% pass rate (0/3) to ≥50% pass rate over a fresh batch of at least 6 trials.
- **Gemma on AIDA-cruise** holds its pass rate at ≥80% while reducing mean turns from ~32 to ≤22, and reducing mean cost per pass.
- **No regression on read-only goals** (brigikiss-programs, aida-ships): all models that previously passed these still pass.
- **Per-field traceability:** for every `fill_form` action in the trace, a human can answer "which fields did the sub-routine try to fill, with what values, and which succeeded?" without reading any source code.
- **Cost attribution preserved:** the run report distinguishes driver-loop spend from `fill_form` sub-routine spend so we can keep optimising both independently.

### What `fill_form` must handle gracefully even if it can't succeed

- Fields hidden by CSS, off-screen, or marked as honeypots — never written to, always reported as skipped.
- Custom widgets that aren't native HTML form controls (date pickers, autocomplete dropdowns, masked inputs, rich-text editors) — recognised as "out of scope", reported as skipped, never silently mis-filled.
- Forms inside an iframe — at minimum, recognised as out of reach and reported clearly. Full descent into iframes is a stretch goal, not a blocker.
- Fields that get revealed after a write earlier in the same form — handled with a small, capped number of internal re-enumeration passes; if the form keeps growing, hand control back to the driver.
- Controls that swallow programmatic value writes silently — detected by reading back the value after writing and either retrying with a keyboard-event path or marking the field skipped.

---

## Out of scope / non-goals

- **Submitting the form.** Always the driver's call.
- **Multi-step wizards as a single action.** Each form/step is one `fill_form` call. The driver re-invokes between steps.
- **CAPTCHAs and bot-detection.** Out of scope; report and let the driver fail the goal.
- **Cross-iframe form filling in v1.** Recognise the iframe boundary and stop.
- **Interpreting the page's broader intent.** The form-filler is told the run goal; it does not navigate, observe other steps, or reason about overall progress.
- **Replacing the driver's judgment about when to fill.** The driver still has to decide that *now* is the right moment to invoke `fill_form` and on which container.

---

## Pairing fixes (must ship in the same window)

The failure analysis identifies three failure classes. `fill_form` only addresses one of them (form-tool avoidance). Without the other two fixes shipping alongside, A/B comparisons against this milestone will be muddled because the dominant cost drivers (premature `done`, ref loops) will still be present.

- **Stuck detection in the driver loop.** When the same reference is acted on three times in a row without the URL or visible DOM state changing, escalate. Without this, devstral's 100-turn $0.607 edit-loop class of failure is not addressed by anything in this milestone.
- **Driver prompt nudge against premature `done`.** Make it explicit that `done` may only be called once the goal-defining UI state is visibly present. Without this, gpt-4.1-nano's "declare victory on the wrong page" failure mode persists regardless of how good `fill_form` is.

These are listed here so the milestone is honest about what it can and cannot fix. Each is its own sub-task and can ship independently — but the success bar above only makes sense when measured *after* all three are in place.

---

## Decision gates

### Before we commit to building (proof-of-concept gate)

A 30-minute manual experiment: pick one failed Mistral-small AIDA run from the existing dataset, hand the form's accessible sub-tree plus the run goal to a stronger model, ask it for a `{field → value}` mapping, then have a script apply those values to a fresh browser session and observe whether the form populates correctly and the page advances.

- If the form populates and the page advances on the first try: the architecture works, build it.
- If the form populates but a custom widget breaks the run: build it, but with the widget-detection scope made explicit.
- If the model can't reliably name the fields well enough to map values back to the page: stop. The fundamental premise (a sub-routine LLM can do this in isolation) is wrong, and we should pursue prompt-side fixes instead.

### Kill criteria during build

- The sub-routine cannot reliably address the fields it decides values for (the field naming / addressing layer is unstable across re-renders). This is the single technical risk most likely to invalidate the design.
- Cost per pass on AIDA-cruise *increases* across all models after the change. If the sub-routine LLM is paying more than the driver was saving, the architecture has the wrong shape.
- Pass rate on previously-passing goals drops below 100% of what it was. We do not regress to win.

### Honest expectation setting

This milestone is expected to move Mistral-small significantly, move Gemma modestly (faster and cheaper rather than more accurate), and barely move the OpenAI nano models — because their failure mode is judgment, not tool access. That outcome is a success of the milestone, not a failure: it tells us the next investment should be in the judgment-side fixes, not in further tool-surface refactoring.

---

## Open questions

1. **What does the driver see in its tool schema for `fill_form`?** A single ref argument, or also a free-text "intent" hint the driver passes down to bias the sub-routine (e.g. "first passenger details" vs "second passenger details")? Defer until after the PoC; let the data say whether the goal alone is enough context.
2. **Does the form-filler use the same model as the driver, or a fixed cheap-and-strong model regardless of run config?** Likely the latter (a fixed cheap-and-strong model so weak driver runs still get good form filling), but this is a choice, not a given.
3. **What happens when the same form is partially filled already** (e.g. the driver navigated back to a step where some fields are pre-populated)? Treat pre-filled fields as authoritative and only fill the empty ones, or always overwrite to the sub-routine's chosen values? Default: respect existing values unless they're invalid.
4. **Verifier expectations.** The verifier currently reads the final snapshot and the action history. Does seeing one `fill_form` step (with its per-field details) instead of 12 separate fills change how often it accepts a run as "done correctly"? Worth measuring on the success-bar batch.
5. **iframes.** Defer or include in v1? Recommendation: defer. None of the failing AIDA runs are iframe-related; Typeform iframes appear once in the dataset and aren't a hot path.
