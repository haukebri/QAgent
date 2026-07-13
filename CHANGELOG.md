# QAgent consumer changelog

This document covers consumer-facing changes released from **2026-07-06 through
2026-07-13** in `v0.7.0` and `v0.8.0`.
It is written for services that invoke the `qagent` CLI, consume its JSON or
NDJSON output, or call `runQAgent()` directly.

## Availability

| Change set | Availability |
|---|---|
| Screenshot evidence | Released in `v0.7.0` |
| Claim verification, locale, recovery, and human verdicts | Released in `v0.8.0` |

`v0.7.0` points to commit `faf1d35`. `v0.8.0` points to commit `b9a73d7` and
contains the 15 commits made after `v0.7.0`.

## Migration checklist

- Keep using `outcome` as the authoritative `pass`, `fail`, or `error` result.
- Allow additive JSON fields. Output can contain `finalScreenshot`, `checks`,
  `verifierMode`, and `humanEvidence`; JSON and trace payloads also contain
  `locale`.
- Allow `goBack` in the `action.action` union of streamed turn events.
- Use `checks` and compact `evidence` for automation and debugging. Use
  `humanEvidence ?? evidence` for text shown to people.
- Do not interpret `verifierMode: "single"` and `checks: []` as "nothing was
  checked". It means claim decomposition failed and QAgent used its older
  single-call verifier.
- Decide whether unverified claims are acceptable in your service. A claim with
  `verdict: "unknown"` currently produces a warning but does not fail the run.
- Do not match browser-action error strings exactly. Overlay errors now include
  page text, available controls, and recovery guidance.
- Revisit verifier budgets and timeouts. Verification uses one decomposition
  call plus one call per claim and one human-summary call after successful
  claim checks.
- Write goals as stable, visibly checkable claims. Prefer named UI text, items,
  URLs, and dialog contents over vague states, volatile counts, or mandatory
  retry wording.

## Usage changes

### Screenshot evidence

CLI callers can opt in to viewport JPEGs:

```bash
qagent --url https://example.com --evidence-dir ./evidence "Verify checkout"
```

Direct integrations can pass the equivalent runner option:

```js
const result = await runQAgent({
  url,
  goal,
  model,
  resolveRequestAuth,
  evidenceDir: './evidence',
});
```

When capture succeeds, turn events can contain a relative `screenshot` such as
`step-01.jpg`, and the final result can contain `finalScreenshot: "final.jpg"`.
The fields are optional because capture failures do not fail the run.
`--evidence-dir` is a CLI flag or runner argument; it is not a config key or
environment variable.

### Browser locale

Use the page's locale when goals quote localized UI:

```bash
qagent --url https://example.de --locale de-DE "Verify checkout"
# or: QAGENT_LOCALE=de-DE qagent --url https://example.de "Verify checkout"
```

`locale` can also be set in user/project config or passed to `runQAgent()`.
Values must be valid BCP-47 locale tags. The default remains `en-US`. JSON and
trace payloads record the effective locale as `locale`; the NDJSON final
envelope and direct runner result do not.

### Structured verifier result

Committed claim-based verification adds these fields to direct results, JSON,
trace payloads, and the final NDJSON event:

```json
{
  "outcome": "pass",
  "evidence": "verified 2 of 3 claims; 1 unverified",
  "verifierMode": "checks",
  "checks": [
    {
      "claim": "the cart URL ends with /shop/cart",
      "verdict": "yes",
      "evidence": "The final URL is https://example.com/shop/cart."
    },
    {
      "claim": "the cart contains Product A",
      "verdict": "unknown",
      "evidence": "The recorded snapshot does not show the cart contents."
    }
  ],
  "warnings": ["unverified claim: the cart contains Product A"]
}
```

Any `no` claim fails the run. `unknown` claims pass with warnings. Consumers
that require proof for every claim must reject `unknown` themselves.

### Human-facing verdict

Version `0.8.0` adds `humanEvidence` to direct results, JSON, trace payloads, and
the final NDJSON event. It separates presentation text from the compact, stable
verifier aggregate:

```js
const messageForUser = result.humanEvidence ?? result.evidence;
const decision = result.outcome;
```

`humanEvidence` is presentation-only and cannot change `outcome`. In checks
mode it is produced by an additional LLM call. If that call fails after retry,
QAgent keeps the original outcome, copies compact `evidence` into
`humanEvidence`, and adds a `verifier human summary unavailable: ...` warning.
Single-verifier fallback also reuses `evidence`. Runner or pre-navigation errors
can leave `humanEvidence` null, so the fallback above is required.

The human `list` reporter now prints `humanEvidence` when present. Services
that snapshot or parse the human reporter should switch to `json` or `ndjson`;
the human text is intentionally prose.

## Commit-by-commit changes

### 2026-07-06

#### [`ac2fe7b` — Screenshot evidence](https://github.com/haukebri/QAgent/commit/ac2fe7bfa823bb93b128940ff166c5096ee13056)

Added `--evidence-dir` and `runQAgent({ evidenceDir })`. Successful captures add
optional `screenshot` fields to turns and `finalScreenshot` to final results.
Screenshots are viewport JPEGs taken before each action plus one final image.

**Consumer action:** Accept the additive fields if consuming structured output.
Pass an evidence directory only when the service needs image artifacts.

#### [`faf1d35` — Release 0.7.0](https://github.com/haukebri/QAgent/commit/faf1d357606d9f9242423757ab8c76f51505a3a8)

Bumped the npm package from `0.6.1` to `0.7.0`. This is the last commit included
in the `v0.7.0` tag.

**Consumer action:** Upgrade to `@qagent/cli@0.7.0` for screenshot evidence.
None of the July 10 changes below are part of that npm version.

### 2026-07-10 — released in `v0.8.0`

#### [`1c24876` — Wait through busy snapshots when settling](https://github.com/haukebri/QAgent/commit/1c24876b63ae5af8ea4adb3182e7dabbce23d0d0)

Loading indicators, progress bars, and busy snapshots no longer count as a
settled page. Runs can wait longer for real content instead of acting on a
temporary loading state.

**Consumer action:** No API change. Allow for slightly different turn timing
and fewer actions against incomplete pages.

#### [`b4c301b` — Add `goBack` driver action](https://github.com/haukebri/QAgent/commit/b4c301bb539200ffaaf25a8454f097627f35185d)

The driver can return to the previous browser-history entry after a wrong
navigation. Streamed and recorded turn actions can now contain
`{ "action": "goBack" }`.

**Consumer action:** Add `goBack` to strict action enums and renderers.

#### [`7da328a` — Adjust fail prompt recovery guidance](https://github.com/haukebri/QAgent/commit/7da328a6e39efe4cc54dba08529ce64200e3943d)

The driver now attempts recovery, including `goBack`, before declaring a goal
impossible. This can produce more turns and change early failures into passes.

**Consumer action:** No schema change. Review tight turn or cost limits if they
assumed the driver would fail immediately after a wrong click.

#### [`71ad664` — Tighten verifier step assertions](https://github.com/haukebri/QAgent/commit/71ad6647a972d8416e965b7f26411e3e6449aa0d)

Explicit goal steps became required assertions: reaching the same final state
through another route was no longer sufficient. The trajectory and observation
diffs were added as evidence. This behavior was subsequently implemented more
explicitly by claim-based verification.

**Consumer action:** Ensure generated goals distinguish required routes from
descriptive guidance. Remove steps whose exact path is not actually required.

#### [`97c04e9` — Add browser locale option](https://github.com/haukebri/QAgent/commit/97c04e9bdfff37747bd1eb3c96111217a6e615f2)

Added `--locale`, `QAGENT_LOCALE`, config key `locale`, and
`runQAgent({ locale })`. JSON and trace payloads now record `locale`.

**Consumer action:** Pass a locale when goal text relies on localized labels,
consent dialogs, or validation messages. Accept the new payload field.

#### [`e32eb25` — Add claim-based verifier checks](https://github.com/haukebri/QAgent/commit/e32eb2511f0143a3ffb080ffdfde476ed44f3707)

Replaced the normal single verifier call with goal decomposition followed by
one check per claim. Added `checks` to direct results and machine-readable
reporters. A denied claim fails; an unknown claim passes with a warning. Compact
`evidence` now summarizes claim aggregation rather than always being a natural
language sentence.

**Consumer action:** Parse `checks`, decide how to handle `unknown`, and account
for verifier cost and latency growing with the number of claims. Do not display
compact `evidence` as polished prose once `humanEvidence` is available.

#### [`daba7a2` — Fix settle polling during navigation](https://github.com/haukebri/QAgent/commit/daba7a2ce4322a2313cfb09c7be36b91b9076f9b)

Transient Playwright observation failures during navigation now keep polling
until the settle deadline instead of ending the settle loop immediately.

**Consumer action:** No API change. Navigation runs should be less flaky and
may take closer to the configured internal settle deadline.

#### [`89994c2` — Add benchmark test script](https://github.com/haukebri/QAgent/commit/89994c2d59b2a528624eb51066d8037efcf82690)

Added the repository-only `run-tests.sh` benchmark for three external sites.
The script is not included in the published npm package.

**Consumer action:** None, unless another service copied or invokes this
repository script.

#### [`0d29781` — Tighten verifier checklist prompts](https://github.com/haukebri/QAgent/commit/0d297810b2a7a91dfb1ec09e761e62881f13b421)

Refined claim decomposition and checking for form fields, conditional retries,
exact counts, named sections, and transient dialogs. Missing evidence should
become `unknown`; concrete contradictory evidence becomes `no`.

**Consumer action:** Treat warning volume and verdicts as potentially changed.
Phrase retry steps conditionally and prefer named expected items over exact
counts when the count is not the requirement.

#### [`d94d250` — Record verifier fallback mode](https://github.com/haukebri/QAgent/commit/d94d2503c14e2d46f6bbea2536227f0cd594d719)

Added `verifierMode: "checks" | "single" | null` to direct results, JSON, trace,
and final NDJSON events. Claim-decomposition failure now emits a warning and
falls back to the older single-call verifier with an empty `checks` array.

**Consumer action:** Branch on `verifierMode`, not on whether `checks` is empty.
Surface or record fallback warnings because the verdict used a different path.

#### [`a357b7d` — Guard done verdicts against visible errors](https://github.com/haukebri/QAgent/commit/a357b7dcbff55e9b309ca00522d0202276a1cafb)

Before accepting the driver's `done`, QAgent now asks the driver model whether
the success summary contradicts visible validation or failure messages. A
contradiction converts the terminal driver verdict to failure before final
verification. The call is included in driver token and cost totals.

**Consumer action:** Expect some former false passes to fail and budget for one
additional driver-model call when a run reaches `done`.

#### [`beb401b` — Start AIDA benchmark at tariff selection](https://github.com/haukebri/QAgent/commit/beb401b1644c1735e729439a5268a1b93642888c)

Changed only the repository benchmark goal and starting assumptions.

**Consumer action:** None, unless another service depends on `run-tests.sh` or
compares its benchmark results across revisions.

#### [`4d79ead` — Enrich overlay-blocked click errors](https://github.com/haukebri/QAgent/commit/4d79eade66fd4bdbbeccdc97e672dc3a5c29a8ed)

Click errors caused by overlays now include a bounded excerpt of overlay text,
up to five control labels, the blocking element, and recovery guidance. The
driver can use this information to dismiss the overlay.

**Consumer action:** Treat action errors as opaque diagnostic text. Replace
exact string comparisons with error presence or a stable prefix check.

## Release `v0.8.0` — 2026-07-13

These changes landed in commit `f8fbc03` and are included in `v0.8.0`.

### Human verdict summaries

After successful claim checks, the verifier makes a final prose-only call that
creates `humanEvidence`. It receives the authoritative outcome and checks and
is explicitly forbidden from changing the decision. Direct results and all
machine-readable final payloads expose the new field; the list reporter prefers
it over compact `evidence`.

**Consumer action:** Display `humanEvidence ?? evidence`, continue deciding on
`outcome`, and accept null `humanEvidence` on early runtime errors. Include the
extra summary call and possible retry in cost and timeout estimates. Monitor the
new summary-unavailable warning without treating it as a failed run.

### Automatic overlay recovery

When a click is blocked by a cookie banner or modal, QAgent now tries to clear
the overlay and retries the original click once. It looks for known consent and
dismiss buttons on the page and in child frames, preferring accept-all controls,
then reject or necessary-only controls, then close controls. If none are found,
it presses Escape once. Successful recovery is recorded on the turn as
`recoveredVia: "overlay"`.

If cleanup does not unblock the target, QAgent returns the original overlay
diagnostic to the driver. CAPTCHA, paywall, authentication, and site-specific
interstitial handling remain unchanged.

**Consumer action:** Accept `"overlay"` as an additive `recoveredVia` value in
turn events and traces. Expect fewer model turns spent on consent dialogs. Note
that automatic recovery accepts optional cookies when an accept-all control is
available.

### Goal-writing guidance

Documentation now reflects claim-based verification. It recommends stable UI
labels, named expected items, recorded transient dialog contents, relevant URL
assertions, locale matching, and conditional recovery steps. These patterns
reduce `unknown` checks and false failures.

**Consumer action:** Update services that synthesize goals to follow these
patterns. In particular, avoid volatile button counts such as `"Weitere 6
Produkte anzeigen"` when only the button and its effect matter.

### Benchmark runner behavior

The repository-only `run-tests.sh` runs one instance of each benchmark
concurrently per iteration, writes trace files under the repository `results/`
directory, and uses `|| true`, so individual QAgent exit codes no longer
determine the script's exit status. Its Vorwerk goal also avoids exact and
volatile counts.

**Consumer action:** None for npm or runner users. Services invoking this script
must read trace outcomes instead of relying on the script exit code and must
allow three concurrent browser/LLM runs.

### [`b9a73d7` — Release 0.8.0](https://github.com/haukebri/QAgent/commit/b9a73d7)

Bumped the npm package from `0.7.0` to `0.8.0` and published the changes above
under the `v0.8.0` tag.

**Consumer action:** Upgrade to `@qagent/cli@0.8.0` for claim-based
verification, browser locale support, recovery improvements, structured human
verdicts, and automatic overlay dismissal.
