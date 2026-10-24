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

test('ESPN schedule and gamelog normalisation', async () => {
  const { normaliseSchedule, normaliseGamelog, etDateOf } = await import('../scripts/fetch-espn.mjs');
  const sched = normaliseSchedule({ events: [
    { date: '2026-10-22T02:00Z', seasonType: { type: 2 }, competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: 'LAL' } }, { homeAway: 'away', team: { abbreviation: 'GS' } }] }] },
    { date: '2026-10-10T02:00Z', seasonType: { type: 1 }, competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: 'LAL' } }, { homeAway: 'away', team: { abbreviation: 'PHX' } }] }] },
    { date: '2026-10-25T00:00Z', seasonType: { type: 2 }, competitions: [{ competitors: [{ homeAway: 'away', team: { abbreviation: 'LAL' } }, { homeAway: 'home', team: { abbreviation: 'WSH' } }] }] },
  ] }, 'LAL');
  assert.deepEqual(sched, [['2026-10-21', 'GSW', 1], ['2026-10-24', 'WAS', 0]]);
  assert.equal(etDateOf('2026-10-22T02:00Z'), '2026-10-21');
  const gl = normaliseGamelog({ names: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'fieldGoalPct', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointPct', 'freeThrowsMade-freeThrowsAttempted', 'freeThrowPct', 'totalRebounds', 'assists', 'blocks', 'steals', 'fouls', 'turnovers', 'points'],
    events: { e1: { gameDate: '2026-10-21T23:30:00.000+00:00' }, e2: { gameDate: '2026-10-24T00:00:00.000+00:00' }, p1: { gameDate: '2026-10-10T00:00:00.000+00:00' } },
    seasonTypes: [{ displayName: '2026-27 Preseason', categories: [{ events: [{ eventId: 'p1', stats: ['20', '5-9', '55.6', '1-3', '33.3', '2-2', '100', '4', '3', '0', '1', '2', '1', '13'] }] }] },
      { displayName: '2026-27 Regular Season', categories: [{ events: [{ eventId: 'e1', stats: ['36', '11-20', '55.0', '2-6', '33.3', '5-6', '83.3', '13', '11', '1', '1', '2', '3', '29'] }, { eventId: 'e2', stats: ['30', '8-15', '53.3', '1-4', '25.0', '4-4', '100', '10', '9', '0', '2', '1', '2', '21'] }] }] }] });
  assert.equal(gl.length, 2, 'preseason excluded');
  assert.deepEqual(gl[0], ['2026-10-23', 30, 21, 10, 9, 2, 0, 1, 8, 15, 4, 4, 2], 'newest first, ET date');
  assert.deepEqual(gl[1], ['2026-10-21', 36, 29, 13, 11, 1, 1, 2, 11, 20, 5, 6, 3]);
});
