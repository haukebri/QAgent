# Task 04: Add Infrastructure-Level Overlay and Cookie Handling

## Problem

Real sites often show cookie banners, consent managers, login dialogs, or modal overlays before the actual task UI can be used. Multiple QAgent failures were dominated by overlay handling rather than task reasoning.

Examples:

- Landefeld exposed an `Accept all` button, but clicks were blocked by an iframe overlay. The driver retried it 98 times.
- AIDA frequently showed Usercentrics/cookie overlays or `dialog.cmp-modal` blockers.
- Some runs clicked content underneath an overlay and then spiraled into stale refs or repeated blocked actions.

The model should not have to rediscover basic overlay dismissal on every turn.

## Goal

Add a reusable overlay handling layer that runs before normal driver actions or after overlay-blocked errors. It should dismiss common cookie/consent/modal blockers when a safe, visible dismissal control is present.

## Scope

Implement helper logic in `src/tools.js` or a small new module used by `src/executor.js`.

Handle common cases:

- Buttons named `Accept all`, `Alle Cookies akzeptieren`, `Yes, I agree`, `No, thanks`, `Optionale Cookies deaktivieren`.
- Usercentrics-style roots such as `#usercentrics-root`.
- Consentmanager iframes/dialogs.
- Generic modal/dialog close buttons where accessible names indicate close/dismiss.
- Escape key fallback for dismissible modals.

Recommended behavior:

- Before each normal snapshot or first action, optionally attempt one passive overlay cleanup.
- If an action fails with `click blocked by overlay: ...`, try overlay cleanup once, then retry the original action once.
- Record `recoveredVia: "overlay"` or similar in the step history when recovery succeeds.

## Non-Goals

- Do not solve CAPTCHA.
- Do not bypass paywalls or security interstitials.
- Do not click arbitrary buttons just because they are in a dialog.
- Do not accept risky permissions or browser prompts.
- Do not make site-specific hacks unless they are expressed as general overlay patterns.

## Suggested Implementation

Start with a conservative helper:

```js
async function dismissCommonOverlays(page, actionTimeoutMs) {
  const names = [
    'Accept all',
    'ALLE COOKIES AKZEPTIEREN',
    'Alle Cookies akzeptieren',
    'Yes, I agree',
    'No, thanks',
    'Optionale Cookies deaktivieren',
  ];
  // Try accessible button names first.
  // Then try common iframe/dialog roots with frameLocator where needed.
  // Return a description when something was dismissed.
}
```

Integrate it so failed overlay clicks do not immediately bounce back to the model when the harness can safely clear the blocker.

## Acceptance Criteria

- A visible same-frame cookie button can be dismissed before task actions begin.
- A common consent iframe with an accessible accept button can be dismissed.
- If a click is blocked by an overlay, the harness attempts one overlay cleanup and one retry of the original click.
- The trace records when overlay recovery happened.
- If no safe dismissal control is found, the executor surfaces the original overlay error to the model.
- The Landefeld-style consent overlay no longer causes dozens of repeated clicks.

## Example Failure This Prevents

`results/2026-04-29T10-00HE7AA.json` never searched for `IQST 40 LE` because the cookie/privacy overlay blocked all `Accept all` clicks. Overlay handling should clear or classify this blocker before the model burns the run budget.
