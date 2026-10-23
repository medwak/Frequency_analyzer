import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBundle, BUNDLE_PATH } from '../scripts/build.mjs';

test('www/js/app.bundle.js matches the module sources (run "npm run build")', () => {
  assert.ok(readFileSync(BUNDLE_PATH, 'utf8') === buildBundle(), 'bundle is stale: run npm run build');
});
