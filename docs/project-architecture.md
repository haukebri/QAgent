# qa harness architecture

AI-driven QA testing. Browser is driven by script. LLM is the decider.

## modules

Each module is one file, one or two exported functions. No classes.

### observer.js

Page to text. Takes a playwright page, returns `{ text, refs }`.
`text` is the compact snapshot the LLM reads. `refs` maps numbers to locators.

### tools.js

Browser actions. One function per action. Start with click, fill, navigate.
Each takes `(page, refs, args)`.

### verifier.js

End-state checks. Pure code, no LLM. `urlMatches`, `visibleText`, etc.

### planner.js

Goal to ordered todos. One LLM call with JSON output.
Each todo has a verifiable end-state.

### executor.js

The loop. For one todo: observe, LLM picks action, run action, verify.
Exits on done, stuck, or turn cap.

### recorder.js

Append JSON lines to a trace file.

### runner.js

Top level. Load spec, run planner, iterate todos through executor.

### cli.js

Parse argv, call runner.

## dependencies

- `playwright`: browser driver. Used only in observer.js and tools.js.
- `pi-ai`: LLM calls. Used only in planner.js and executor.js.
- `pi-agent-core`: agent loop. Used only in executor.js.

## data flow

```
spec -> runner -> planner returns todos
for each todo:
  executor loop: observer -> LLM decide -> tool -> verifier
  recorder captures every step
runner aggregates results
```

## build order

1. `observe.js`: open a page with playwright, dump the a11y tree
2. `observer.js`: compact text format with numbered refs
3. `tools.js`: click, fill, navigate
4. `executor.js`: hardcoded todo, full loop working end to end
5. `recorder.js`: trace output
6. `planner.js`: goal to todos
7. `runner.js` and `cli.js`: wire it up
8. eval harness against a reference app

## rules

- No classes.
- No folders until a module outgrows a file.
- No TypeScript until something breaks without it.
- No config objects. Function arguments only.
- Under 200 lines for the MVP.
- If a module needs more than two exports, split or simplify.
