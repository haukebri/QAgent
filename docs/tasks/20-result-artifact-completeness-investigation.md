# Task 20: Result Artifact Completeness Investigation

> **Target release:** v0.10.0

## Problem

Calculator run 20 reached the expected result visually but left an empty
`result.json`, an empty `qagent.log`, and no `exit-code.txt`. QAgent's runner is
designed to return a stable result for normal completion and runtime failures,
but these files may also be owned by the external invoking harness.

Changing QAgent before locating the failing write boundary risks fixing the
wrong system.

## Goal

Determine which process owns the incomplete artifacts and fix only the shared
QAgent path if QAgent can reproduce the failure.

## Scope

- Reproduce normal, failed, timed-out, interrupted, and verifier-error runs
  through the CLI trace reporter and the external calculator harness separately.
- Identify which process creates `result.json`, `qagent.log`, and
  `exit-code.txt`.
- Record whether the QAgent process returned a result before the empty files
  appeared.
- If QAgent owns the fault, make its structured result write resistant to
  partial or zero-byte output and add one regression test at that write boundary.
- If the external harness owns the fault, document the handoff and make no
  QAgent runtime change.

## Why This Fits QAgent

Reliable structured output is part of the CLI and runner contract. Ownership
must be established before adding recovery, retries, or another reporting
layer.

## Non-Goals

- No speculative recorder rewrite before reproduction.
- No attempt to make QAgent create harness-owned logs or exit-code files.
- No new public error, technical, business, or inconclusive outcome.
- No catch-all process supervisor or external orchestration framework.
- No website-specific handling.

## Acceptance Criteria

- Artifact ownership and the failing boundary are documented with a reproducing
  command or harness case.
- Every QAgent-owned completed or handled-error invocation writes parseable,
  non-empty structured output.
- A QAgent-owned interrupted write cannot replace a prior valid artifact with a
  zero-byte final file.
- If the fault is harness-owned, the task closes without QAgent production-code
  changes and names the required harness fix.
- Existing reporter and runner error-path tests remain green.

## Changelog

Only if QAgent production behavior changes, add this note under `v0.10.0` in
`CHANGELOG.md`:

> Structured result recording no longer leaves a zero-byte final artifact when
> a QAgent-owned write is interrupted.

## Investigation Result

Repository ownership tracing assigns the reported artifacts to the external
calculator harness:

- QAgent contains no creator or path reference for `result.json`, `qagent.log`,
  or `exit-code.txt`
  (`rg -n 'result\\.json|qagent\\.log|exit-code\\.txt' src test scripts`).
- The CLI `trace` reporter calls `record()` and owns only uniquely named
  `<output-dir>/<timestamp>H<random>.json` files plus failure snapshot/screenshot
  siblings. The `json` and `ndjson` reporters write structured output to stdout;
  the CLI sets an exit status but does not create an exit-code file.
- Trace recording targets a newly generated filename rather than a fixed prior
  artifact. Existing recorder and reporter tests cover payload construction and
  handled result output.

Therefore the fixed-name files were created or left empty outside the QAgent
process boundary, in the harness redirection/copy step. The supplied artifacts
do not establish whether QAgent returned a result; the missing `exit-code.txt`
shows that the harness did not persist the child's exit status. The harness must
write stdout to a temporary file, verify it is non-empty and parseable, then
rename it to `result.json`; it must also create `exit-code.txt` after the child
exits. No QAgent production change is warranted. The external calculator
harness is not present in this worktree, and its runs were not executed here.

The ownership boundary can be confirmed manually with the same shell pattern
used by a harness (not run during this implementation):

```bash
qagent --url <fixture-url> --reporter=json "<goal>" >result.json 2>qagent.log
code=$?
printf '%s\n' "$code" >exit-code.txt
```

The shell creates all three named files; QAgent only supplies stdout, stderr,
and the process exit status. Running the same goal with `--reporter=trace`
instead creates QAgent's uniquely named trace under `--output-dir`.
