# Task 04: Overlay Auto-Dismissal

## Status

Detection is in place: `diagnoseClickFailure` in `src/tools.js` already classifies blocked clicks as `kind: 'overlay'` and tells the model. What's missing is automatic dismissal of common consent/cookie/modal overlays so the LLM doesn't have to discover and click through them on every run.

Re-confirmed 2026-05-04: a qwen3.5-flash run against the Gravity Forms test page failed because a Privacy Settings dialog overlay (`ref=e607`) blocked the form. The other 4/5 runs passed — overlays are the dominant remaining flake source.

## Goal

When a click reports `kind: 'overlay'`, the harness attempts one overlay-cleanup pass and one retry of the original click before bouncing the error back to the model.

## Scope

- Add a small helper (in `src/tools.js` or a sibling module) that tries, in order:
  1. Click the first visible button whose accessible name matches a known consent/dismiss pattern (`Accept all`, `Alle Cookies akzeptieren`, `Reject all`, `No, thanks`, `Close`, `Dismiss`, …).
  2. Press `Escape` once for dismissible modals.
- Call the helper from the click path in `tools.js` only when `diagnoseClickFailure` returns `kind: 'overlay'`. Then retry the original click once. If still blocked, surface the original error.
- Record `recoveredVia: "overlay"` in the recorder step so traces show when the harness cleared a blocker.

## Non-goals

- No CAPTCHA, paywall, or auth interstitial handling.
- No site-specific selectors. Patterns must be general (accessible names + dialog/iframe roots).
- No proactive cleanup before every action — only react to a confirmed overlay-blocked click.

## Acceptance

- A run against a page with a standard cookie banner that previously failed now passes without the LLM clicking the dismiss button itself.
- The trace shows `recoveredVia: "overlay"` on the recovered step.
- A page with no safe dismissal control still surfaces the original overlay error to the model (no infinite loops).
