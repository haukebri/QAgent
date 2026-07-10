import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLocale } from '../src/config.js';

test('validates BCP-47-looking locales', () => {
  assert.equal(validateLocale('de-DE'), 'de-DE');
  assert.equal(validateLocale('fr-FR'), 'fr-FR');
  assert.throws(() => validateLocale('de_DE'), /BCP-47 locale/);
  assert.throws(() => validateLocale(''), /BCP-47 locale/);
});
