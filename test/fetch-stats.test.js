import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalise } from '../scripts/fetch-stats.mjs';

test('fetch-stats normalises the NBA Stats resultSet and refuses malformed payloads', () => {
  const json = JSON.parse(readFileSync(new URL('./fixtures/nba-stats-sample.json', import.meta.url), 'utf8'));
  const p = normalise(json);
  assert.equal(Object.keys(p).length, 4);
  assert.deepEqual(p['Victor Wembanyama'], { team: 'SAS', gp: 3, min: 33.4, pts: 26.7, reb: 12.0, ast: 3.0, stl: 1.0, blk: 4.0, tpm: 2.3, fgm: 9.7, fga: 19.3, ftm: 5.0, fta: 6.0, tov: 3.3 });
  assert.throws(() => normalise({ resultSets: [{ headers: ['PLAYER_NAME'], rowSet: [] }] }), /missing column/);
  assert.throws(() => normalise({}), /unexpected payload/);
});
