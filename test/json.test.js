import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJsonObject } from '../src/json.js';

test('extracts the first complete JSON object from common LLM responses', () => {
  const cases = [
    ['{"ok":true}', '{"ok":true}'],
    ['```json\n{"ok":true}\n```', '{"ok":true}'],
    ['prefix {"text":"a } brace and \\"quote\\""} commentary {"ignored":true}', '{"text":"a } brace and \\"quote\\""}'],
  ];
  for (const [input, expected] of cases) assert.equal(extractJsonObject(input), expected);
  assert.equal(extractJsonObject('{"incomplete":true'), null);
  assert.throws(() => JSON.parse(extractJsonObject('{bad}') ?? ''), SyntaxError);
});
