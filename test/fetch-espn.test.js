import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normaliseStats, normaliseInjuries } from '../scripts/fetch-espn.mjs';

test('ESPN stats normalise by stat name, not column order; malformed payloads are refused', () => {
  const json = JSON.parse(readFileSync(new URL('./fixtures/espn-stats-sample.json', import.meta.url), 'utf8'));
  const p = normaliseStats(json);
  assert.deepEqual(p['Anthony Edwards'], { team: 'MIN', pos: 'SG', gp: 2, min: 36, reb: 5.5, ast: 4.5, stl: 1.5, blk: 0.5, tov: 3.5, pts: 30.5, fgm: 10, fga: 23, tpm: 4, ftm: 6.5, fta: 8 });
  assert.equal(p['Nikola Jokić'].pts, 29);
  assert.throws(() => normaliseStats({ categories: [{ names: ['gamesPlayed'] }], athletes: [] }), /missing fields/);
  assert.throws(() => normaliseStats({}), /unexpected/);
});

test('ESPN injuries normalise to status/type/return date per player', () => {
  const json = JSON.parse(readFileSync(new URL('./fixtures/espn-injuries-sample.json', import.meta.url), 'utf8'));
  const inj = normaliseInjuries(json);
  assert.equal(inj['Jimmy Butler'].status, 'Out');
  assert.equal(inj['Jimmy Butler'].returnDate, '2027-01-02');
  assert.equal(inj['Stephen Curry'].status, 'Day-To-Day');
  assert.equal(inj['Stephen Curry'].type, 'Ankle');
  assert.throws(() => normaliseInjuries({}), /unexpected/);
});
