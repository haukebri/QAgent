import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalContract } from '../src/goal-contract.js';

test('selects only an explicitly binding Acceptance section', () => {
  const fullGoal = 'Persona: enter 99.\nOnly the Acceptance section is binding.\nAcceptance:\n- Ready is visible.\nNotes:\nIgnore this.';
  assert.deepEqual(createGoalContract(fullGoal), {
    fullGoal,
    verificationGoal: '- Ready is visible.',
    source: 'acceptance',
  });
});

test('keeps the full goal without both explicit scope markers', () => {
  for (const fullGoal of [
    'Acceptance:\n- Ready is visible.',
    'Only the Acceptance section is binding.\n- Ready is visible.',
    'Ready is visible.',
  ]) {
    assert.deepEqual(createGoalContract(fullGoal), {
      fullGoal,
      verificationGoal: fullGoal,
      source: 'full-goal',
    });
  }
});
