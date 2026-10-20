import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATS, LEAGUE, ROSTER_SIZE, teamOnClock, picksForSlot, nextPickForSlot, followingPickForSlot,
  resolveName, parseNameList, computeValues, assignRoster, openSlots, recommend,
  createState, draftPlayer, undoLastPick, availablePlayers, myRoster, isMyTurn, currentOverall,
} from '../src/engine.js';
import { PLAYERS } from '../src/data.js';

test('nine categories with correct directionality', () => {
  assert.equal(CATS.length, 9);
  assert.deepEqual(CATS.map(c => c.label), ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'ST', 'BLK', 'TO']);
  const to = CATS.find(c => c.key === 'tov');
  assert.equal(to.higherIsBetter, false);
  for (const c of CATS.filter(c => c.key !== 'tov')) assert.equal(c.higherIsBetter, true);
});

test('league settings match the brief', () => {
  assert.equal(LEAGUE.teams, 10);
  assert.deepEqual(LEAGUE.slots, ['PG','SG','G','SF','PF','F','C','C','Util','Util','BN','BN','BN']);
  assert.equal(LEAGUE.ilSlots, 4);
  assert.equal(ROSTER_SIZE, 13);
});

test('10-team snake order reverses each round', () => {
  assert.equal(teamOnClock(1, 10), 1);
  assert.equal(teamOnClock(10, 10), 10);
  assert.equal(teamOnClock(11, 10), 10);
  assert.equal(teamOnClock(20, 10), 1);
  assert.equal(teamOnClock(21, 10), 1);
  assert.equal(teamOnClock(25, 10), 5);
  assert.equal(teamOnClock(36, 10), 5); // round 4 reversed: pick 36 -> idx 5 -> team 10-5 = 5
  assert.equal(teamOnClock(130, 10), 10); // round 13 is odd: slot 10 closes the draft
  assert.equal(teamOnClock(121, 10), 1);
});

test('overall picks for a slot and next-pick calculation', () => {
  assert.deepEqual(picksForSlot(1, 10, 4), [1, 20, 21, 40]);
  assert.deepEqual(picksForSlot(10, 10, 4), [10, 11, 30, 31]);
  assert.deepEqual(picksForSlot(4, 10, 3), [4, 17, 24]);
  assert.equal(nextPickForSlot(4, 10, 5), 17);
  assert.equal(nextPickForSlot(4, 10, 4), 4);
  assert.equal(followingPickForSlot(4, 10, 4), 17);
  assert.equal(followingPickForSlot(4, 10, 17), 24);
  assert.equal(nextPickForSlot(4, 10, 200), null);
  assert.equal(picksForSlot(7, 10).length, 13);
});

test('name resolution: exact, partial, diacritics, ambiguity, none', () => {
  assert.equal(resolveName('Nikola Jokić', PLAYERS).match.id, 'jokic');
  assert.equal(resolveName('wembanyama', PLAYERS).match.id, 'wemby');
  assert.equal(resolveName('SGA', PLAYERS).none, true);
  assert.equal(resolveName('Jaren Jackson', PLAYERS).match.id, 'jjj');
  const amb = resolveName('Murray', PLAYERS);
  assert.ok(amb.ambiguous && amb.ambiguous.length >= 3, 'Murray must be ambiguous (Jamal, Dejounte, Keegan)');
  assert.equal(resolveName('J Murray', PLAYERS).match.id, 'jmurray');
  const thompsons = resolveName('Thompson', PLAYERS);
  assert.ok(thompsons.ambiguous && thompsons.ambiguous.length >= 2);
  assert.equal(resolveName('Ausar Thompson', PLAYERS).match.id, 'ausar');
  assert.equal(resolveName('Zzyzx Nobody', PLAYERS).none, true);
  assert.deepEqual(parseNameList('TAKEN: Anthony Edwards, Jalen Brunson,  Victor Wembanyama'), ['Anthony Edwards', 'Jalen Brunson', 'Victor Wembanyama']);
  assert.deepEqual(parseNameList('a\nb; c'), ['a', 'b', 'c']);
});

test('z-score model: turnovers negative, percentage impact volume-aware, missing data gets no advantage', () => {
  const base = { reb: 5, ast: 5, stl: 1, blk: 1, tpm: 2, pts: 20, fga: 15, fta: 5, gp: 70 };
  const mk = (id, extra) => ({ id, name: id, team: 'X', positions: ['PG'], fgp: .47, ftp: .80, tov: 2, ...base, ...extra });
  const players = [
    mk('lowTO', { tov: 1.0 }), mk('highTO', { tov: 4.0 }),
    mk('bigFGlowVol', { fgp: .65, fga: 3 }), mk('goodFGhighVol', { fgp: .55, fga: 18 }),
    mk('missingBLK', { blk: undefined }),
    ...Array.from({ length: 20 }, (_, i) => mk('f' + i, { pts: 15 + i * 0.5, tov: 2 + (i % 3) * 0.5 })),
  ];
  const v = computeValues(players, { poolSize: 25 });
  const by = Object.fromEntries(v.map(p => [p.id, p]));
  assert.ok(by.lowTO.z.tov > 0 && by.highTO.z.tov < 0, 'fewer turnovers must score positive');
  assert.ok(by.goodFGhighVol.z.fgp > by.bigFGlowVol.z.fgp, 'FG% impact must account for attempts');
  assert.equal(by.missingBLK.z.blk, 0);
  assert.deepEqual(by.missingBLK.missing, ['blk']);
  assert.equal(by.missingBLK.fallback, true);
  assert.ok(by.lowTO.value > by.highTO.value);
});

test('real data: Jokic and Wembanyama rank at the top; Giannis punished in FT% but boosted when punting it', () => {
  const v = computeValues(PLAYERS);
  const top3 = v.slice(0, 3).map(p => p.id);
  assert.ok(top3.includes('jokic') && top3.includes('wemby'), `top3 was ${top3}`);
  const g = v.find(p => p.id === 'giannis');
  assert.ok(g.z.ftp < -1.5, 'Giannis FT% should be a big negative');
  const punted = computeValues(PLAYERS, { weights: { ftp: 0 } });
  const g2 = punted.find(p => p.id === 'giannis');
  assert.ok(g2.modelRank < g.modelRank, 'punting FT% must improve Giannis rank');
  assert.ok(v.every(p => p.missing.length === 0), 'dataset should have no missing stats');
});

test('roster assignment honours slot eligibility, two C slots and flex', () => {
  const P = (id, pos) => ({ id, name: id, positions: pos });
  const r = assignRoster([P('c1', ['C']), P('c2', ['C']), P('c3', ['C']), P('pg', ['PG']), P('g', ['SG'])]);
  const slotOf = id => r.assignments.find(a => a.player?.id === id)?.slot;
  assert.equal(slotOf('pg'), 'PG');
  assert.equal(slotOf('g'), 'SG');
  assert.equal(r.assignments.filter(a => a.slot === 'C' && a.player).length, 2);
  assert.ok(['Util', 'BN'].includes(slotOf('c3')));
  assert.equal(r.overflow.length, 0);
  assert.ok(r.unfilled.includes('G') && r.unfilled.includes('SF') && r.unfilled.includes('PF') && r.unfilled.includes('F'));
  // a full roster of 13 leaves nothing open; a 14th cannot be placed
  const full = Array.from({ length: 13 }, (_, i) => P('p' + i, ['PG', 'SG', 'SF', 'PF', 'C']));
  assert.equal(openSlots(full).length, 0);
  const over = assignRoster([...full, P('extra', ['C'])]);
  assert.equal(over.overflow.length, 1);
  // PG-only players cannot fill C slots
  const pgs = Array.from({ length: 13 }, (_, i) => P('pg' + i, ['PG']));
  const rr = assignRoster(pgs);
  assert.ok(rr.unfilled.includes('C'));
  assert.ok(rr.overflow.length >= 1);
});

test('draft state: duplicate prevention, availability, my roster, undo', () => {
  let s = createState({ mySlot: 3 });
  assert.equal(currentOverall(s), 1);
  assert.equal(isMyTurn(s), false);
  s = draftPlayer(s, 'jokic');
  s = draftPlayer(s, 'wemby');
  assert.equal(isMyTurn(s), true);
  assert.throws(() => draftPlayer(s, 'jokic'), /already drafted/);
  s = draftPlayer(s, 'sga');
  assert.deepEqual(myRoster(s, PLAYERS).map(p => p.id), ['sga']);
  const avail = availablePlayers(s, PLAYERS);
  assert.ok(!avail.some(p => ['jokic', 'wemby', 'sga'].includes(p.id)));
  assert.equal(avail.length, PLAYERS.length - 3);
  s = undoLastPick(s);
  assert.equal(currentOverall(s), 3);
  assert.deepEqual(myRoster(s, PLAYERS), []);
  assert.ok(availablePlayers(s, PLAYERS).some(p => p.id === 'sga'));
  assert.equal(undoLastPick(undoLastPick(undoLastPick(s))).picks.length, 0);
  // manual removal (player not in Yahoo pool) also makes them unavailable
  s = { ...s, removed: ['luka'] };
  assert.ok(!availablePlayers(s, PLAYERS).some(p => p.id === 'luka'));
});

test('recommendation never returns a drafted player and recalculates when the target is taken', () => {
  const valued = computeValues(PLAYERS);
  let s = createState({ mySlot: 1 });
  const rec1 = recommend(availablePlayers(s, valued), [], { currentPick: 1, nextPick: 20 });
  assert.ok(rec1.best);
  const first = rec1.best.player.id;
  s = { ...s, mySlot: 2 };
  s = draftPlayer(s, first); // team 1 takes my target
  const rec2 = recommend(availablePlayers(s, valued), [], { currentPick: 2, nextPick: 19 });
  assert.notEqual(rec2.best.player.id, first);
  assert.ok(rec2.backups.length === 2);
  assert.ok(!rec2.candidates.some(c => c.player.id === first));
  assert.ok(['high', 'medium', 'low'].includes(rec2.confidence));
});

test('recommendation respects roster needs: late in the draft with both C slots open, a C is favoured', () => {
  const valued = computeValues(PLAYERS);
  const byId = Object.fromEntries(valued.map(p => [p.id, p]));
  // 9 non-centres on the roster, two C slots open
  const roster = ['sga', 'maxey', 'edwards', 'tatum', 'jjohnson', 'dwhite', 'reaves', 'tmurphy', 'og'].map(id => byId[id]);
  const avail = valued.filter(p => !roster.includes(p) && p.modelRank > 40 && p.modelRank < 110);
  const rec = recommend(avail, roster, { currentPick: 100, nextPick: 101 });
  assert.ok(rec.open.includes('C'));
  assert.ok(rec.best.player.positions.includes('C'), `expected a C, got ${rec.best.player.name}`);
});

test('recommendation works when projection data is missing (fallback flagged)', () => {
  const sparse = [
    { id: 'a', name: 'A', team: 'X', positions: ['C'], pts: 20, reb: 10, ast: 2, stl: 1, blk: 2, tpm: 1, fgp: .55, fga: 14, ftp: .75, fta: 5, tov: 2, gp: 70 },
    { id: 'b', name: 'B', team: 'X', positions: ['PG'], pts: 18, ast: 8, gp: 70 }, // no reb/stl/blk/tpm/%/tov
    { id: 'c', name: 'C', team: 'X', positions: ['SF'], pts: 10, reb: 4, ast: 2, stl: 1, blk: 0.5, tpm: 1.5, fgp: .45, fga: 9, ftp: .8, fta: 2, tov: 1, gp: 70 },
  ];
  const v = computeValues(sparse, { poolSize: 3 });
  const b = v.find(p => p.id === 'b');
  assert.equal(b.fallback, true);
  assert.ok(b.missing.length >= 6);
  const rec = recommend(v, [], { currentPick: 1, nextPick: 20 });
  assert.ok(rec.best);
  assert.ok(rec.candidates.length === 3);
});

test('IL-type players (long-term out) carry a risk flag the recommender surfaces', () => {
  const valued = computeValues(PLAYERS);
  const rec = recommend(valued, [], { currentPick: 70, nextPick: 71 });
  const butler = rec.candidates.find(c => c.player.id === 'butler');
  assert.ok(butler.flags.some(f => /OUT/i.test(f)));
  assert.ok(butler.flags.some(f => /games/.test(f)));
});
