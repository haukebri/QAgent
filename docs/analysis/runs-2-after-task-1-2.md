# Runs 2 Analysis After Tasks 1 and 2

Date: 2026-05-01  
Data source: `docs/analysis/runs-2.csv` and matching `results/2026-05-01T*.json` traces.

## Summary

Tasks 1 and 2 are making progress on the exact failure modes they targeted:

- The malformed action issue is gone in the new runs. There are no `unknown action: undefined` errors in the May 1 result files.
- Repeated-ref loops are much smaller. The old dataset had a worst repeated ref count of 98; `runs-2.csv` tops out at 4.
- Average turns dropped from 23.6 to 16.5.
- Average run cost dropped from $0.038 to $0.016.
- Average clicks dropped from 14.8 to 7.6.

However, overall pass rate is not cleanly better because the second dataset includes a new `req-eng-admin` goal with many one-turn auth errors, and Gravity Forms regressed.

| Dataset | Runs | Pass | Fail | Error | Pass rate | Non-error pass rate | Avg turns | Avg cost | Max repeated ref |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `runs.csv` | 38 | 13 | 22 | 3 | 34.2% | 37.1% | 23.6 | $0.038 | 98 |
| `runs-2.csv` | 35 | 9 | 13 | 13 | 25.7% | 40.9% | 16.5 | $0.016 | 4 |

The headline pass rate went down, but that is mostly because errors increased from 3 to 13. If errors are excluded, pass rate improved slightly from 37.1% to 40.9%.

## New Run Breakdown

By model:

| Model | Runs | Pass | Fail | Error | Pass rate | Avg turns | Avg cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| `google/gemma-4-26b-a4b-it` | 15 | 9 | 5 | 1 | 60.0% | 20.3 | $0.009 |
| `gpt-5.4-nano` | 20 | 0 | 8 | 12 | 0.0% | 13.7 | $0.021 |

By goal:

| Goal | Runs | Pass | Fail | Error | Notes |
|---|---:|---:|---:|---:|---|
| `req-eng-admin` | 15 | 4 | 0 | 11 | All non-error runs passed; errors are basic-auth navigation failures. |
| `aida-cruise` | 10 | 5 | 5 | 0 | Gemma is now 5/5; GPT remains 0/5. |
| `gravity-form` | 10 | 0 | 8 | 2 | Regressed; no successful submissions. |

## Comparable Before/After Cells

| Model + goal | Old | New | Read |
|---|---:|---:|---|
| Gemma + AIDA cruise | 4/5 | 5/5 | Better. This is the clearest success. |
| Gemma + Gravity Forms | 1/2 | 0/5 | Worse. Repeated final state still shows the form. |
| GPT-5.4-nano + AIDA cruise | 0/3 | 0/5 | Still failing, but cheaper and shorter. |
| GPT-5.4-nano + Gravity Forms | 1/3 | 0/5 | Worse; now includes 2 errors. |

## Did Task 1 Work?

Yes.

Before task 1, GPT produced many valid-but-wrong action shapes such as:

```json
{"click": "e184"}
```

Those showed up as `unknown action: undefined`, especially in Ryanair runs.

In the May 1 result files, there are no `unknown action: undefined` errors. The normalization layer is doing its job.

Remaining malformed output is no longer a visible driver of failures in `runs-2.csv`.

## Did Task 2 Work?

Mostly yes.

The runaway-loop profile is much better:

- Old worst repeated ref: 98 (`Accept all` on Landefeld).
- New worst repeated ref: 4 (`Pruefen` on AIDA cabin number).
- GPT AIDA failures are much shorter: old average 42.3 turns and $0.049; new average 23.0 turns and $0.021.

This means stuck detection is saving cost and preventing long tail loops.

It does not make stuck runs pass. It makes them fail faster and with better evidence, which is the right behavior for this fix.

## New Issues

### 1. Basic Auth Is Being Left to the Model

The new `req-eng-admin` goal says:

```text
with the basic auth req // req, login with the credentials haukebr@gmail.com // test123
```

Gemma sometimes handled this correctly, but GPT repeatedly put the app login credentials into the basic-auth URL:

```text
https://haukebr%40gmail.com:test123@req-eng-frontend.haukebrinkmann.com/
```

That produced one-turn errors:

```text
page.goto: net::ERR_INVALID_AUTH_CREDENTIALS
```

There was also a Gemma error with:

```text
https://req%40eng:test123@req-eng-frontend.haukebrinkmann.com/
```

Recommendation: basic auth should be a harness/spec capability, not something the driver model invents inside a URL. Use Playwright `httpCredentials` from the runner/spec when basic auth is provided.

### 2. Gravity Forms Is Now the Biggest Product Failure

Gravity Forms is 0/10 in `runs-2.csv`.

Gemma fills required fields and clicks Submit, but then frequently calls `done` even though the final snapshot still shows the form and the `Submit Inquiry` button.

Example:

```text
Although the page content hasn't visibly changed to a 'result' page...
```

The verifier correctly fails these runs.

GPT does more repair work but still leaves validation errors:

```text
Name: This field is required
Services Needed: This field is required
```

Recommendation: task 3 (`done` gating) is now clearly next. If the goal requires a result page, do not accept `done` while the original form and submit button are still visible.

### 3. Form Field State Is Sometimes Misread

One GPT Gravity final snapshot shows:

```text
Name: This field is required. Please complete the following fields: Last.
```

while the visible `Last` textbox contains `Brinkmann`.

That could mean:

- The site validation state is stale.
- The field value was visually present but not accepted by the form script.
- The snapshot includes stale notification/live-region text.
- The model fixed the field but did not re-submit successfully.

Recommendation: dynamic wait / validation-aware form handling is needed. Generic `wait` is not enough.

### 4. Navigation Can Escape to Non-HTML Assets

`2026-05-01T02-52H7803.json` ended at:

```text
https://www.gravityforms.com/wp-content/uploads/2026/03/Icon-BYOA-1.svg
```

Then observation failed:

```text
locator.ariaSnapshot: Selector "body" does not match any element
```

Recommendation: add a guard for unexpected non-HTML navigations. If `page.url()` points to an image/PDF/SVG while the goal expects a webpage, go back or fail with a clearer navigation-escaped reason.

### 5. `done` Is Still Accepted Too Easily

Task 2 reduces loops, but terminal decisions remain too trusting. In new runs, several failed Gravity Forms cases ended with `done` while the form was still present.

Recommendation: implement task 3 next.

## Are We Making Progress?

Yes, but not evenly.

Clear progress:

- Schema drift is fixed for this run set.
- Loop explosions are largely gone.
- AIDA + Gemma improved from 80% to 100%.
- GPT AIDA failures are much cheaper and shorter.
- Non-error pass rate improved slightly.

Not progress yet:

- Overall pass rate went down because auth/navigation errors increased.
- GPT-5.4-nano still has 0 passes in this run set.
- Gravity Forms regressed to 0 passes.
- The system still accepts premature `done`.

## Recommended Next Order

1. Implement task 3: gate `done`.
2. Move basic auth out of model prompting and into runner/spec/browser context.
3. Implement task 5: dynamic waits, especially `waitForText` and `waitForUrl`.
4. Add a non-HTML navigation guard.
5. Continue with task 4 overlay handling, but it is less urgent than `done` gating and auth based on these runs.

Bottom line: tasks 1 and 2 improved the harness quality. They did not magically improve all task success, but they turned some pathological failures into shorter, cheaper, more diagnosable failures. That is real progress.
