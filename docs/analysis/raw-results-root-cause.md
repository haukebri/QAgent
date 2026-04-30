# Raw Results Root-Cause Analysis

Date: 2026-04-30  
Data source: `results/*.json`, final failure snapshots, and `docs/analysis/runs.csv`.

## Executive Summary

The surprising result is not that less capable models are inherently better browser agents. The stronger explanation is that some models are more disciplined about QAgent's current tool contract.

Passing runs use concrete browser tools more often, especially `fill` and `selectOption`. Failed runs click more, retry refs more, and sometimes infer success from a URL or a stale text fragment instead of from the current page state.

The biggest improvements are harness-level, not model-selection-only:

1. Repair common malformed action JSON.
2. Detect repeated no-progress loops.
3. Gate premature `done` calls.
4. Handle common overlays/cookie banners outside the model loop.
5. Add evidence-based dynamic waits.

These are now captured as task docs under `docs/tasks/`.

## Dataset Caveat

The existing `docs/analysis/model-failures.md` says the verifier was held constant, but the raw result files show multiple verifier models:

- `qwen/qwen3.5-flash-02-23`
- `mistral-small-2603`
- `gpt-5.4-nano`
- `google/gemma-4-26b-a4b-it`

So the pass rates are useful directionally, but they are not a clean controlled benchmark. Some apparent model differences may be partially verifier differences.

Also, most model/goal cells have very small sample sizes. Treat model-specific conclusions as hypotheses backed by trace evidence, not final rankings.

## Headline Numbers

Total raw result JSON files inspected: 38.

Overall outcomes:

| Outcome | Runs |
|---|---:|
| Pass | 13 |
| Fail | 22 |
| Error | 3 |

Provider-family summary:

| Provider family | Runs | Pass | Fail | Error | Pass rate |
|---|---:|---:|---:|---:|---:|
| Google | 15 | 8 | 7 | 0 | 53.3% |
| Mistral family | 9 | 3 | 5 | 1 | 33.3% |
| OpenAI | 14 | 2 | 10 | 2 | 14.3% |

Model summary:

| Model | Runs | Pass | Fail | Error | Pass rate |
|---|---:|---:|---:|---:|---:|
| `google/gemma-4-26b-a4b-it` | 15 | 8 | 7 | 0 | 53.3% |
| `devstral-2512` | 5 | 2 | 2 | 1 | 40.0% |
| `mistral-small-2603` | 4 | 1 | 3 | 0 | 25.0% |
| `gpt-5.4-nano` | 11 | 2 | 8 | 1 | 18.2% |
| `gpt-4.1-nano` | 3 | 0 | 2 | 1 | 0.0% |

## Strongest Behavioral Signal

Action mix tracks outcome better than perceived model intelligence.

| Outcome | Avg clicks | Avg fills | Avg selectOptions |
|---|---:|---:|---:|
| Pass | 11.4 | 5.7 | 2.0 |
| Fail | 18.5 | 3.0 | 0.5 |

The same pattern is even clearer on the hard AIDA cruise flow:

| AIDA cruise outcome | Avg clicks | Avg fills | Avg selectOptions |
|---|---:|---:|---:|
| Pass | 21.0 | 11.6 | 4.6 |
| Fail | 22.3 | 3.1 | 0.6 |

Conclusion: successful drivers complete forms. Failed drivers click around.

## Global Failure Reasons

### 1. Repeated No-Progress Ref Loops

The executor currently tells the model about errors, but it does not detect repeated no-progress behavior.

Representative examples:

- `2026-04-29T10-00HE7AA.json`: Landefeld clicked `Accept all` 98 times. Each click was blocked by `iframe#I0_1777456322093`.
- `2026-04-29T10-48H5AA3.json`: Devstral clicked AIDA `Aendern` 29 times and alternated with save actions until the 100-turn cap.
- `2026-04-30T07-09H9DDD.json`: `gpt-5.4-nano` clicked AIDA `Versicherung` sidebar/generic refs repeatedly while still stuck on `/meine-reise/daten`.
- `2026-04-30T07-01H7D19.json` and `2026-04-30T07-03H1C03.json`: `gpt-4.1-nano` reused earlier AIDA refs after navigation and ended on `/kabine`.

Needed improvement: task `02-stuck-detection.md`.

### 2. Premature `done`

The driver often stops when the goal is not actually satisfied. The verifier catches this, but the executor has already ended the driver loop.

Representative examples:

- AIDA: `gpt-4.1-nano` called `done` while still on the cabin step (`/meine-reise/kabine`), not insurance.
- Ryanair: Gemma called `done` after reaching or attempting the results URL, while the final snapshot still showed the search form or a disabled Search button.
- Gravity Forms: `gpt-5.4-nano` called `done` while the snapshot still contained validation text: "Services Needed: This field is required".

Needed improvement: task `03-gate-done-verdict.md`.

### 3. Malformed Action JSON

Some models returned valid JSON in the wrong shape, especially `gpt-5.4-nano` on Ryanair.

Bad shape:

```json
{"click": "e184", "summary": "Click Search"}
```

Expected shape:

```json
{"action": "click", "ref": "e184", "summary": "Click Search"}
```

The executor parses the malformed JSON, but then `action.action` is missing, so the action becomes `unknown action: undefined`. This wastes turns and can trap the model in repeated schema mistakes.

Representative examples:

- `2026-04-30T07-24H87FC.json`: 19 malformed-action turns.
- `2026-04-30T07-29HFB98.json`: malformed `click` action before partial recovery.

Needed improvement: task `01-repair-action-json.md`.

### 4. Overlay and Cookie Banner Handling

Several failures are dominated by overlay mechanics rather than task reasoning.

Representative examples:

- Landefeld final snapshot still shows a privacy settings dialog and visible search field, but clicks on `Accept all` are blocked by a consent iframe.
- AIDA runs frequently encounter `div#usercentrics-root` or `dialog.cmp-modal` blockers.

The model should not have to solve common consent modal patterns from scratch in every run.

Needed improvement: task `04-overlay-handling.md`.

### 5. Dynamic Page and Timing Gaps

Ryanair is the clearest case. Runs often fill the search form and sometimes reach a `/trip/flights/select?...` URL, but final snapshots still show homepage/search-form content, disabled filters, or no fare cards.

This can come from several causes:

- SPA route has not hydrated yet.
- Search button is still disabled.
- Results are loading after the current fixed wait.
- Bot-detection or site instability is preventing render.
- The verifier sees a URL that looks successful but no visible evidence.

Current tools only support generic `wait`. They do not let the driver wait for a URL fragment, expected text, enabled button, or disappearance of loading state.

Needed improvement: task `05-dynamic-waits.md`.

### 6. Incomplete Evidence for Pass Audits

`src/recorder.js` saves final snapshots only for non-pass runs. That makes failed runs easy to inspect and passing runs harder to audit. For example, Ryanair has one pass with concrete fare evidence in the JSON, but there is no pass snapshot to inspect symmetrically.

Recommended follow-up: save final snapshots for all runs, or at least behind a `--save-pass-snapshots` option.

## Per Provider and Model

### Google: `google/gemma-4-26b-a4b-it`

Runs: 15. Passes: 8.

Strengths:

- Best overall pass rate in this dataset.
- Strongest on AIDA cruise, where it actually performs the form filling and selection work.
- Relatively cheap per successful run compared with Devstral and GPT runs.

Failure pattern:

- Dynamic Ryanair tasks fail often. The model sometimes declares success from URL/search progress without visible flight cards.
- Landefeld failure is mostly overlay/tooling: 98 blocked clicks on `Accept all`.
- Some premature `done` behavior remains.

Interpretation:

Gemma is currently the best baseline, but not because it is universally smarter. It is better aligned with the current one-action browser loop and form-tool expectations.

### OpenAI: `gpt-5.4-nano`

Runs: 11. Passes: 2.

Strengths:

- Can complete simpler/static tasks and one Gravity Forms run.
- Uses `fill` reasonably often.

Failure pattern:

- Repeated-ref loops on AIDA.
- Malformed action JSON on Ryanair.
- Low `selectOption` usage relative to successful AIDA runs.
- Premature `done` on Gravity Forms despite validation errors.
- Some infrastructure errors, including navigation timeout and missing snapshot cases.

Interpretation:

This model often appears to reason about the intended state rather than grounding hard enough in the exact current snapshot and schema. It needs stricter executor feedback and schema repair.

### OpenAI: `gpt-4.1-nano`

Runs: 3. Passes: 0.

Failure pattern:

- Calls `done` on AIDA while still on `/kabine`.
- Almost no form-tool usage on multi-step form flows.
- One browser context closed error in a Typeform flow.

Interpretation:

Too little data for a final model judgement, but the available traces show premature completion and weak form progression.

### Mistral Family: `devstral-2512`

Runs: 5. Passes: 2.

Strengths:

- Can solve AIDA cruise when it stays on track.
- Uses `fill` and `selectOption`, unlike `mistral-small`.

Failure pattern:

- Catastrophic looping cost when stuck. One AIDA failure hit 100 turns and about $0.607 driver cost.
- One empty/invalid LLM response run.
- One provider auth error.

Interpretation:

Devstral is capable but risky without stuck detection. It needs guardrails before it is cost-safe.

### Mistral Family: `mistral-small-2603`

Runs: 4. Passes: 1.

Strengths:

- Fine for simple static navigation.

Failure pattern:

- Zero `fill` and zero `selectOption` actions across all four runs.
- Cannot handle multi-step form workflows in this dataset.
- Clicks generic AIDA/sidebar elements and then fails.

Interpretation:

This model may be useful for read-only/static goals, but it is currently a poor driver for form-heavy workflows.

## Recommended Fix Order

1. `01-repair-action-json.md`: low-risk, immediate reduction in wasted turns from schema drift.
2. `02-stuck-detection.md`: highest cost savings; prevents 100-turn loops.
3. `03-gate-done-verdict.md`: prevents false driver completion before verifier failure.
4. `04-overlay-handling.md`: removes a class of real-site failures that models should not solve repeatedly.
5. `05-dynamic-waits.md`: improves SPA and post-submit reliability, especially Ryanair and Gravity Forms.
6. Save pass snapshots for audit parity.

## Bottom Line

The current failures are a mix of model behavior and harness gaps. The more capable models often fail because they are less obedient to the narrow action schema, more willing to infer completion, and more likely to keep trying a plausible but ineffective action. The harness should be stricter and more helpful: repair safe schema mistakes, stop loops, reject contradicted `done`, clear common overlays, and wait for concrete evidence.

After those fixes, rerun a controlled matrix with one verifier model and repeated trials per goal. That will give a fairer answer to which provider/model is actually best for QAgent.
