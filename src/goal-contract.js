export function createGoalContract(fullGoal) {
  const lines = fullGoal.split(/\r?\n/);
  const heading = lines.findIndex(line => /^Acceptance:\s*$/iu.test(line));
  const explicitlyScoped = /\bonly\s+the\s+Acceptance\s+section\s+is\s+binding\b/iu.test(fullGoal);
  if (!explicitlyScoped || heading < 0) {
    return { fullGoal, verificationGoal: fullGoal, source: 'full-goal' };
  }

  const end = lines.findIndex((line, index) => index > heading && /^[A-Za-z][\w -]*:\s*$/u.test(line));
  const verificationGoal = lines.slice(heading + 1, end < 0 ? undefined : end).join('\n').trim();
  return verificationGoal
    ? { fullGoal, verificationGoal, source: 'acceptance' }
    : { fullGoal, verificationGoal: fullGoal, source: 'full-goal' };
}
