import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etDateOf, weekRange, weekOf, gamesFor, playoffGames, projectWeek, compareWeek, needWeights, streamCandidates, playingOn, recentAverages, applyRecentForm, normTeam, SEASON } from '../src/engine.js';

test('ET dates and Yahoo weeks', () => {
  assert.equal(etDateOf('2026-10-22T02:00Z'), '2026-10-21'); // 10pm EDT the night before
  assert.equal(etDateOf('2026-12-10T00:30Z'), '2026-12-09'); // EST
  assert.equal(etDateOf('2026-10-21T23:30Z'), '2026-10-21');
  assert.deepEqual(weekRange(1), { week: 1, start: '2026-10-20', end: '2026-10-25' });
  assert.deepEqual(weekRange(2), { week: 2, start: '2026-10-26', end: '2026-11-01' });
  assert.equal(weekOf('2026-10-24').week, 1);
  assert.equal(weekOf('2026-10-27').week, 2);
  assert.equal(weekOf('2026-11-01').week, 2);
  assert.equal(weekOf('2026-11-02').week, 3);
  assert.equal(weekRange(20).start, '2027-03-01');
  assert.deepEqual(SEASON.playoffWeeks, [20, 21, 22]);
  assert.equal(normTeam('WSH'), 'WAS'); assert.equal(normTeam('GS'), 'GSW'); assert.equal(normTeam('BOS'), 'BOS');
});

const sched = { teams: {
  PHI: [['2026-10-27', 'BOS', 1], ['2026-10-29', 'NYK', 0], ['2026-10-31', 'MIA', 1], ['2026-11-01', 'ATL', 0], ['2027-03-02', 'X', 1], ['2027-03-10', 'X', 1], ['2027-03-20', 'X', 1]],
  WAS: [['2026-10-28', 'CHA', 1], ['2026-10-30', 'ORL', 0]],
  DEN: [['2026-10-27', 'LAL', 1], ['2026-10-28', 'MIN', 0], ['2026-10-30', 'SAS', 1], ['2026-11-01', 'DAL', 1]],
} };
const P = (id, team, extra) => ({ id, name: id, team, positions: ['PG'], pts: 20, reb: 5, ast: 5, stl: 1, blk: 1, tpm: 2, fgp: .5, fga: 15, ftp: .8, fta: 5, tov: 2, z: { pts: 1, ast: 1, tpm: 1, stl: 0, blk: 0, reb: 0, fgp: 0, ftp: 0, tov: 0 }, ...extra });

test('schedule lookups count games in a range and playoff weeks; ESPN codes map', () => {
  assert.equal(gamesFor(sched, 'PHI', '2026-10-26', '2026-11-01').length, 4);
  assert.equal(gamesFor(sched, 'WSH', '2026-10-26', '2026-11-01').length, 2);
  assert.equal(playoffGames(sched, 'PHI'), 3);
  assert.equal(playoffGames(sched, 'WAS'), 0);
});

test('weekly projection respects games, injuries and remaining dates; comparison labels categories', () => {
  const me = [P('a', 'PHI'), P('b', 'WAS', { injury: { status: 'Out', returnDate: '2026-11-20' } })];
  const w = weekRange(2);
  const proj = projectWeek(me, sched, w);
  assert.equal(proj.games, 4, 'injured player contributes 0 games');
  assert.equal(proj.totals.pts, 80);
  assert.ok(Math.abs(proj.totals.fgp - 0.5) < 1e-9);
  const partial = projectWeek(me, sched, { ...w, fromDate: '2026-10-30' });
  assert.equal(partial.games, 2);
  const opp = [P('c', 'DEN', { pts: 10, tov: 6 })];
  const cmp = compareWeek(proj, projectWeek(opp, sched, w));
  const by = Object.fromEntries(cmp.map(r => [r.key, r]));
  assert.ok(by.pts.pWin > 0.9 && by.pts.state === 'locked');
  assert.ok(by.tov.pWin > 0.9, 'fewer turnovers wins the TO category');
  assert.ok(['swing', 'lean', 'behind'].includes(by.reb.state), by.reb.state);
  const w2 = needWeights(cmp);
  assert.equal(w2.pts, 0); assert.ok(w2.reb > 0);
});

test('streaming ranks by games remaining times fit in needed categories; playingOn flags tonight', () => {
  const fa = [P('x', 'DEN', { z: { pts: 0, ast: 2, tpm: 0, stl: 0, blk: 0, reb: 0, fgp: 0, ftp: 0, tov: 0 } }), P('y', 'WAS', { z: { pts: 0, ast: 3, tpm: 0, stl: 0, blk: 0, reb: 0, fgp: 0, ftp: 0, tov: 0 } })];
  const r = streamCandidates(fa, sched, weekRange(2), { ast: 1 });
  assert.equal(r[0].player.id, 'x', 'four games beats two games even with a lower per-game fit');
  const r2 = streamCandidates(fa, sched, { ...weekRange(2), fromDate: '2026-10-30' }, { ast: 1 });
  assert.equal(r2[0].games, 2);
  const tonight = playingOn([P('a', 'PHI'), P('c', 'DEN')], sched, '2026-10-28');
  assert.deepEqual(tonight.map(t => t.plays), [false, true]);
});

test('recent form averages and blending are volume-aware and idempotent', () => {
  const rows = [['2026-10-25', 36, 30, 6, 8, 2, 1, 4, 10, 20, 6, 6, 3], ['2026-10-23', 34, 20, 4, 6, 1, 0, 2, 8, 16, 2, 4, 2], ['2026-10-21', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
  const f = recentAverages(rows, 10);
  assert.equal(f.gp, 2, 'DNP rows ignored'); assert.equal(f.pts, 25); assert.equal(f.fgp, 0.5); assert.equal(f.ftp, 0.8);
  const p = P('Nikola Jokic', 'DEN', { pts: 27.5, ast: 10.5 });
  const r = applyRecentForm([p], { 'Nikola Jokić': rows }, { n: 10, k: 10 });
  assert.equal(r.matched, 1);
  const w = 2 / 12; const expected = +(27.5 * (1 - w) + 25 * w).toFixed(2);
  assert.equal(r.players[0].pts, expected);
  const again = applyRecentForm(r.players, { 'Nikola Jokić': rows }, { n: 10, k: 10 });
  assert.equal(again.players[0].pts, expected, 'blending twice does not compound');
  assert.equal(applyRecentForm([p], {}, {}).players[0].form, null);
});
