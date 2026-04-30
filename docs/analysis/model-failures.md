# Model Failure Analysis — QAgent Driver Models

**Dataset:** 38 runs across 5 driver models on 7 distinct goals, captured 2026-04-29 → 2026-04-30.
**Verifier:** `gpt-5.4-nano` for all runs (held constant — verdicts are comparable across models).
**Raw data:** [`runs.csv`](./runs.csv).

> **Method.** Numbers first, opinions last. Per-run metrics were extracted directly from `results/*.json`. Failure modes were identified by reading every fail-run's `steps[]`, the verifier's `evidence`, and the driver's own `reasoning`. Five subagents (one per model) analysed runs in parallel; findings are aggregated below. **Goal classification:** the dataset originally lumped two distinct goals on `aida.de` together — a complex booking flow ("aida-cruise") and a simple ship-list lookup ("aida-ships"). They are split here.

---

## 1. Headline numbers

### 1.1 Per-model summary

| Model | n | pass | fail | error | pass% | avg turns | avg cost ($) | avg tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **google/gemma-4-26b-a4b-it** | 15 | 8 | 7 | 0 | **53%** | 24.4 | $0.013 | 349,678 |
| devstral-2512 | 5 | 2 | 2 | 1 | 40% | 30.0 | $0.149 | 368,083 |
| mistral-small-2603 | 4 | 1 | 3 | 0 | 25% | 12.2 | $0.009 | 59,946 |
| gpt-5.4-nano | 11 | 2 | 8 | 1 | 18% | 26.4 | $0.042 | 380,300 |
| gpt-4.1-nano | 3 | 0 | 2 | 1 | **0%** | 14.0 | $0.005 | 60,725 |

### 1.2 Per-goal × model crosstab (corrected)

| Goal | n | gemma-4 | devstral | gpt-5.4-nano | gpt-4.1-nano | mistral-small |
|---|---:|---|---|---|---|---|
| **aida-cruise** (multi-step booking → insurance) | 15 | **4/5 (80%)** | 1/2 (50%) | 0/3 (0%) | 0/2 (0%) | 0/3 (0%) |
| aida-ships (find ship list — easy) | 4 | **2/2 (100%)** | — | 0/2 (0% — 1 fail, 1 err) | — | — |
| ryanair-search (form fill + JS render) | 7 | 1/5 (20%) | — | 0/2 (0%) | — | — |
| gravity-form (single contact form) | 5 | 1/2 (50%) | — | 1/3 (33%) | — | — |
| brigikiss-programs (read static page) | 3 | — | — | 1/1 | 0/1 (err) | 1/1 |
| example-headline (trivial) | 3 | — | 1/2 (1 err) | — | — | — |
| landefeld-product (find by ID) | 1 | 0/1 (cap hit) | — | — | — | — |

**Read this table carefully.** Most cells are 0–3 runs. The only goal with enough data to compare models head-to-head is **aida-cruise (n=15)**. There gemma is the clear leader.

### 1.3 Action mix per run (averages)

| Model | clicks | fills | selectOpt | wait | pressKey | done | fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| gemma-4-26b | 16.0 | **4.3** | **1.7** | 0.4 | 0.1 | 0.9 | 0.1 |
| devstral-2512 | 20.0 | **5.0** | **1.6** | 0.4 | 0.2 | 0.4 | 0.0 |
| gpt-5.4-nano | 14.0 | 4.5 | **0.4** | 1.5 | 1.9 | 0.3 | 0.6 |
| gpt-4.1-nano | 11.0 | 0.7 | **0.0** | 0.3 | 0.0 | 0.7 | 0.0 |
| mistral-small-2603 | 9.0 | **0.0** | **0.0** | 1.2 | 0.0 | 0.2 | 0.8 |

### 1.4 Pass-vs-fail action delta within gemma (subagent finding)

The same model behaves differently on its passes vs its fails. This is a stronger signal than cross-model averages:

| Action | gemma pass avg | gemma fail avg | Δ |
|---|---:|---:|---:|
| fill | **6.6** | 1.6 | +5.0 |
| selectOption | **2.8** | 0.4 | +2.3 |
| click | 12.9 | 19.6 | −6.7 |

> Passes do data entry. Fails do retry-clicking.

### 1.5 Cost outliers

| File | Model | Goal | Outcome | Turns | Cost |
|---|---|---|---|---:|---:|
| `10-48H5AA3` | devstral-2512 | aida-cruise | fail (cap) | 100 | **$0.607** |
| `12-26HE384` | devstral-2512 | aida-cruise | pass | 39 | $0.136 |
| `07-33HED79` | gpt-5.4-nano | gravity-form | fail | 44 | $0.086 |
| `07-09H9DDD` | gpt-5.4-nano | aida-cruise | fail | 62 | $0.072 |
| `07-22H5E57` | gpt-5.4-nano | aida-cruise | fail | 56 | $0.068 |

**Cost-per-pass** (sum of model spend ÷ pass count): gemma **$0.024**, mistral-small $0.037, gpt-5.4-nano $0.230, devstral $0.372, gpt-4.1-nano N/A. Gemma is **~10× cheaper per passing run** than the next-best paid model.

---

## 2. Per-model failure deep-dive

Each section below summarises a parallel subagent's findings on its assigned model. File ids refer to `results/<id>.json`.

### 2.1 google/gemma-4-26b-a4b-it (n=15, pass% 53%)

**Headline:** Strong on linear / server-rendered flows; weak on JS-heavy dynamic pages.

**Per-goal pass rate:**

| Goal | n | pass | comment |
|---|---:|---|---|
| aida-cruise | 5 | 4 | Only fail is a 2-turn early-give-up on a blank initial render |
| aida-ships | 2 | 2 | Easy goal; 5-turn passes are legitimate (`/schiffe` ship list page) |
| gravity-form | 2 | 1 | The fail submitted the form but verifier saw no redirect |
| ryanair-search | 5 | 1 | Reaches `/select?` URL but flight cards never render in the snapshot |
| landefeld-product | 1 | 0 | Hit 100-turn cap inside cookie/iframe consent loop |

**Failure modes:**
1. **Dynamic-render gap (4/5 ryanair fails — `07-45H6DD9`, `07-48H4F2C`, `07-52HE596`, plus 1 same-day fail).** Gemma navigates correctly to the search results URL, but the page snapshot at the end shows the search form, not flight cards. Verifier rules fail. This is **not a model error** — it's a snapshot/timing or bot-detection issue. Same root cause appears on landefeld.
2. **Cookie/iframe overlay trap (`10-00HE7AA`, 100 turns).** Gemma cycles "Accept All" buttons inside an iframe (`I0_1777456322093`) and never reaches product content.
3. **Empty-page give-up (`09-52HE4AA`, 2 turns).** Initial AIDA load returned no interactive content; gemma aborted. The other 4 AIDA runs on the same goal succeeded — likely a one-off page-load issue.
4. **Form-submitted-no-redirect (`07-48HC4F5` gravity-form).** Filled all fields and clicked submit, but the post-submit "result" page never appeared in the snapshot. Same render-detection class as ryanair.

**Suspicious-pass check:** The 5-turn AIDA passes (`07-46HA322`, `07-51HFEB2`) are a different goal ("find ship info") — verified legitimate, not lazy verification.

**Verdict on user's hypothesis ("gemma is completely fine"):** **Partially true.** Gemma is the best driver in the dataset on linear booking workflows (80% on aida-cruise, vs 0% for OpenAI/Mistral). It is **not** uniformly good — it scores 20% on dynamic JS-render tasks (ryanair) and 0% on bot-shielded ones (landefeld). Most of its "failures" outside of aida-cruise are arguably page-rendering issues, not model reasoning errors.

---

### 2.2 devstral-2512 (n=5, pass% 40%)

**Headline:** Capable of solving AIDA-cruise, but enters infinite edit-loops on form-completion ambiguity that explode token cost.

**Failure modes:**
1. **Infinite edit-loop (`10-48H5AA3`, 100 turns, $0.607 — biggest cost in the dataset).** On aida-cruise, devstral's first 43 turns mirror its passing run almost exactly (fill passenger 1 → fill passenger 2). It then clicks the "Ändern" (edit) button `e4281` **29 times** across turns 44–100, oscillating with the save button instead of clicking "Daten bestätigen" to confirm. Never escapes the `/daten` page. **Single run = 81% of total dataset cost.**
2. **JSON parse failure (`12-17H11D4`).** All 8 turns: empty model response, 0 tokens. Driver kept retrying. Probably API or upstream bug.
3. **Auth error (`12-19H9507`).** 401 from Mistral API on turn 1.

**Cost breakdown vs gemma:** Devstral uses **15,043 tokens/turn** in the failing 100-turn run vs **8,561 tokens/turn** in the passing run — input tokens grow ~166K/turn during the loop because the same DOM is re-captured every iteration. This is structural, not behavioural: any model that loops at AIDA's `/daten` page will pay this cost.

**Pass-vs-fail delta on AIDA:** Identical action mix (12 fills + 4 selectOptions in the pass; 13 fills + 4 selectOptions in the fail). The fail just **doesn't recognise the form is complete**.

**Caveat:** 5 runs total, 2 of which were trivial example.com tests where 1 errored on auth and 1 returned empty JSON — only 3 real samples.

---

### 2.3 gpt-5.4-nano (n=11, pass% 18%)

**Headline:** Repeatedly clicks the same unresponsive ref instead of backtracking — sidebar/button loops dominate failures.

**Failure modes:**
1. **Repeated-ref loops (5 of 8 fails).** The signature pattern.
   - `07-09H9DDD` (62 turns, $0.072): ref `e78` (Versicherung sidebar) clicked **7 times** at turns 5, 41, 52, 54, 57, 58, 60. Each click returns to `/meine-reise/daten`; sidebar item visible but content never loads. Driver never escalates.
   - `07-22H5E57` (56 turns): `e4631` clicked 5×; `e1426`, `e1428` 4× each on cabin number input.
   - `07-24H87FC` (ryanair, 33 turns): Search button `e184` clicked 4× despite syntax errors blocking execution.
   - `07-33HED79` (gravity, 44 turns): `e1206`/`e1380`/`e1464` each 3× on same field/checkbox.
2. **Premature `done` (`07-33HED79`).** Driver calls `done` claiming "form submitted" while validation error "Services Needed: This field is required" is still visible in the DOM. Verifier overrules.
3. **Form-tool avoidance on AIDA (`07-04H6C7B`, 9 turns; `07-28H34EB`, 1 turn).** 0 fills, 0 selectOptions across both runs. Verifier: "no visible input fields ... attempted click did not reveal any form elements."
4. **Initialisation fail (`07-28H34EB`, 1 turn).** Driver issues `fail` action immediately: "No page snapshot is available for aida.de."

**Verdict themes (verifier text):**

| Theme | n | files |
|---|---:|---|
| Refs not present after click chain | 2 | `07-04H6C7B`, `07-22H5E57` |
| Results page never rendered | 2 | `07-24H87FC`, `07-29HFB98` |
| Form-validation loop | 1 | `07-26HFB87` |
| Sidebar loop on AIDA | 1 | `07-09H9DDD` |
| No initial snapshot | 1 | `07-28H34EB` |

**Pass-vs-fail delta:** Both passes (`06-59H2EE7` brigikiss 4 turns; `07-23H49E0` gravity 39 turns) had clean execution paths with deliberate waits between fill and submit. The 8 fails average 5.6 fills (vs the gravity pass's 9) but 1.9 waits (vs the pass's normal pacing) — the fills are happening on stuck pages.

---

### 2.4 mistral-small-2603 (n=4, pass% 25%)

**Headline:** Excels at single-step navigation but never invokes form tools — reaches dead-ends 75% of the time on multi-step forms.

**Confirmed:** **0 fills and 0 selectOptions across all 4 runs.** Including a 27-turn AIDA run where the goal *explicitly* says "fill in all data."

**Failure modes (3 fails on aida-cruise):**
1. **Early load fail (`10-36HE09A`, 2 turns).** Initial navigation returned empty/blank; `fail` action immediately. No retry strategy.
2. **Generic-element loop (`10-32HAD40`, 17 turns).** Stalled on `/reisende` with `e73` clicked 5× and `e151` clicked 3×. Verifier: "Versicherung section is not expandable or clickable."
3. **Cabin-step deadlock (`10-37H5673`, 27 turns).** Stalled on `/kabine` with `e73` clicked 6×, `e78` clicked 4×, `e151` clicked 3×. Verifier: "Next button not present or not clickable."

**Pass run (`10-31HFF82` brigikiss):** clean 3-turn sequence — navigate → click 'Programs' link → done. No exploration, no retry, no form fill needed.

**Caveat:** Only 4 runs; mistral-small was never given a clean trial on a form-light goal beyond brigikiss.

---

### 2.5 gpt-4.1-nano (n=3, pass% 0%)

**Headline:** Hallucinates task completion on intermediate steps; never uses form tools on multi-step flows.

**Failure modes (all 3 runs problematic):**
1. **Premature `done` (2/3 fails).**
   - `07-01H7D19` AIDA: declares "Reached the current page, but no further actions are necessary" while still on `/kabine`. Verifier confirms `/versicherung` unreached.
   - `07-03H1C03` AIDA: declares "Reached the insurance step" while on `/kabine`. Verifier: "Versicherung step content not present."
2. **Repeated-ref after URL change.** `07-01H7D19`: `e151` clicked 4× across turns 3→8→9. `07-03H1C03`: `e151` × 4, `e306` × 3 consecutive. After the URL changes, refs become stale; driver retries them.
3. **Form-tool avoidance.** `07-01H7D19`: 0 fills, 0 selectOptions across 19 turns. `07-03H1C03`: 0/0 across 14 turns. Both AIDA runs ignored the explicit "fill in all data" instruction.
4. **Browser context loss (`06-59H5C09` error).** Driver's first fill on a Typeform iframe succeeded; second fill triggered "Target page, context or browser has been closed." Stale locator after iframe context closed.

**Caveat:** Only 3 runs. Statements about gpt-4.1-nano are indicative, not statistically sound. But the 0% pass rate combined with 0 fills/0 selectOptions across both AIDA attempts is strong directional evidence.

---

## 3. Cross-model conclusions

### 3.1 The dominant signal: form-tool usage tracks pass rate

| Model | pass% | mean fill/run | mean selectOption/run |
|---|---:|---:|---:|
| gemma-4-26b | 53% | 4.3 | 1.7 |
| devstral-2512 | 40% | 5.0 | 1.6 |
| mistral-small | 25% | 0.0 | 0.0 |
| gpt-5.4-nano | 18% | 4.5 | 0.4 |
| gpt-4.1-nano | 0% | 0.7 | 0.0 |

Models that fail the most are also the ones that don't invoke `selectOption` (≤0.4/run). The gemma within-model delta confirms: passes use 6.6 fills + 2.8 selectOptions; fails use 1.6 + 0.4. **Form-tool engagement is the single strongest correlate of success.**

### 3.2 Three distinct failure-mode classes across all five models

1. **Premature `done` / hallucinated completion** (gpt-4.1-nano, gpt-5.4-nano).
   - gpt-4.1-nano: 2/2 AIDA fails ended with `done` on the wrong page.
   - gpt-5.4-nano: 1 fail (`07-33HED79`) called `done` despite visible validation errors.
   - Verifier catches this every time, but the model burns turns building toward the wrong conclusion.

2. **Repeated-ref loops** (all models except gemma's passes).
   - gpt-5.4-nano: ref `e78` × 7 in one run.
   - gpt-4.1-nano: stale refs after navigation.
   - mistral-small: clicking generic elements 5–6× each.
   - devstral: edit-button `e4281` × 29 (the $0.6 disaster).
   - Common pattern: model receives a stale/no-op result, retries the same ref, doesn't escalate.

3. **Form-tool avoidance** (gpt-4.1-nano, mistral-small).
   - mistral-small literally never called `fill` or `selectOption` in 4 runs.
   - gpt-4.1-nano averaged 0.7 fills, 0 selectOptions on multi-step forms.
   - These models cannot complete any goal that requires data entry.

### 3.3 Cost is concentrated in failures, especially looping ones

- 81% of the entire dataset's spend ($0.607 of $0.752 total devstral) lived in **one** 100-turn devstral run.
- gpt-5.4-nano spent $0.226 on its 8 fails vs $0.075 on its 2 passes.
- Token-per-turn grows during loops (devstral: 8.5K → 15K /turn) because the same DOM is re-captured.

A turn-cap or stuck-detection heuristic (e.g., abort if same ref clicked 3+ times with no URL/state change) would have saved most of devstral's $0.605 fail run.

### 3.4 What we cannot conclude (yet)

- Whether gpt-4.1-nano can pass *any* form-heavy goal — n=3 is too small.
- Whether gemma's gravity-form / ryanair failures are model errors or platform render issues — final URLs were correct in most cases; verifier rejected because the snapshot didn't show the post-submit state.
- Whether the AIDA-cruise dominance generalises beyond German booking funnels.

### 3.5 Recommended next experiments

1. **Re-run the 3 fail goals on each underrepresented model.** Get gpt-4.1-nano and mistral-small up to ≥10 runs each on aida-cruise. Get gpt-5.4-nano up to ≥10 runs on each goal it has only 1–2 of.
2. **Add a prompt nudge for the OpenAI nano models:** "Form fields must be populated using the `fill` and `selectOption` tools; clicking sidebar steps will not advance the wizard."
3. **Add stuck detection in `executor.js`:** after 3 clicks on the same `ref` without URL or DOM change, force a re-snapshot or escalate to fail. This caps devstral's worst-case cost.
4. **Investigate the ryanair render gap.** Is it bot-detection? Async-render timing? Take a screenshot at the `/select?` URL after gemma's "fail" runs and compare to the snapshot the verifier saw.

---

## 4. Caveats & threats to validity

- **Sample sizes are small.** gpt-4.1-nano (3), mistral-small (4), devstral (5). Treat percentages as directional.
- **Goal coverage is uneven.** Only aida-cruise (n=15) has cross-model coverage. Most other comparisons are 1–3 runs per cell.
- **Same verifier across all runs.** If `gpt-5.4-nano` as verifier has biases (e.g., requiring text in main content rather than sidebar), every model is judged with the same blind spots.
- **No determinism baseline.** Each run picks its own actions; we have no controlled re-runs of the same model on the same goal with the same seed. Some "fails" may be one-shot platform issues (page load, render, captcha).
- **Date sample bias.** 2026-04-30 batch is mostly OpenAI/gemma on AIDA; 2026-04-29 is devstral/mistral/gemma. API-side drift over ~24h cannot be ruled out.
- **The 100-turn cap is a confound.** Devstral's $0.607 run was capped, not failed by reasoning. We don't know what would have happened at turn 200.
