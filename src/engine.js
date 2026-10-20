// Draft War Room engine — pure logic, no DOM. Works as an ES module and when inlined.
// Everything here is deterministic and unit-tested (see test/engine.test.js).

export const CATS = [
  { key: 'fgp', label: 'FG%', higherIsBetter: true,  pct: true, att: 'fga' },
  { key: 'ftp', label: 'FT%', higherIsBetter: true,  pct: true, att: 'fta' },
  { key: 'tpm', label: '3PM', higherIsBetter: true },
  { key: 'pts', label: 'PTS', higherIsBetter: true },
  { key: 'reb', label: 'REB', higherIsBetter: true },
  { key: 'ast', label: 'AST', higherIsBetter: true },
  { key: 'stl', label: 'ST',  higherIsBetter: true },
  { key: 'blk', label: 'BLK', higherIsBetter: true },
  { key: 'tov', label: 'TO',  higherIsBetter: false },
];

export const LEAGUE = {
  name: 'Worldwide League',
  yahooLeagueId: 60156,
  season: '2026-27',
  teams: 10,
  pickClockSeconds: 60,
  scoring: 'H2H 9-cat',
  // Active roster slots in Yahoo order. IL slots are separate (4) and only usable for injured players.
  slots: ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'C', 'Util', 'Util', 'BN', 'BN', 'BN'],
  ilSlots: 4,
};

export const SLOT_ELIGIBILITY = {
  PG: ['PG'], SG: ['SG'], G: ['PG', 'SG'], SF: ['SF'], PF: ['PF'], F: ['SF', 'PF'],
  C: ['C'], Util: null, BN: null, // null = any position
};

export const ROSTER_SIZE = LEAGUE.slots.length; // 13 draftable players

// ---------- Snake draft math ----------
export function teamOnClock(overallPick, numTeams) {
  if (overallPick < 1) throw new Error('overallPick must be >= 1');
  const round = Math.ceil(overallPick / numTeams);
  const idx = (overallPick - 1) % numTeams; // 0-based position within the round
  return round % 2 === 1 ? idx + 1 : numTeams - idx; // 1-based draft slot
}
export function roundOf(overallPick, numTeams) { return Math.ceil(overallPick / numTeams); }
export function pickInRound(overallPick, numTeams) { return ((overallPick - 1) % numTeams) + 1; }

/** All overall pick numbers belonging to draft slot `slot` (1-based). */
export function picksForSlot(slot, numTeams, rounds = ROSTER_SIZE) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    const pos = r % 2 === 1 ? slot : numTeams + 1 - slot;
    out.push((r - 1) * numTeams + pos);
  }
  return out;
}
export function nextPickForSlot(slot, numTeams, currentOverall, rounds = ROSTER_SIZE) {
  return picksForSlot(slot, numTeams, rounds).find(p => p >= currentOverall) ?? null;
}
export function followingPickForSlot(slot, numTeams, currentOverall, rounds = ROSTER_SIZE) {
  const list = picksForSlot(slot, numTeams, rounds).filter(p => p > currentOverall);
  return list[0] ?? null;
}

// ---------- Names ----------
export function normaliseName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`.]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a typed name against players. Returns { match } for a unique hit,
 * { ambiguous: [players] } when several fit, or { none: true }.
 */
export function resolveName(input, players) {
  const q = normaliseName(input);
  if (!q) return { none: true };
  const exact = players.filter(p => normaliseName(p.name) === q);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const parts = q.split(' ');
  const last = parts[parts.length - 1];
  // last-name only, or "first last" with partial first name, or contains
  const contains = players.filter(p => normaliseName(p.name).includes(q));
  if (contains.length === 1) return { match: contains[0] };
  if (contains.length > 1) return { ambiguous: contains };
  const lastOnly = players.filter(p => normaliseName(p.name).split(' ').slice(-1)[0] === last);
  if (lastOnly.length === 1 && parts.length === 1) return { match: lastOnly[0] };
  if (parts.length > 1) {
    const firstInit = parts[0];
    const fl = lastOnly.filter(p => normaliseName(p.name).startsWith(firstInit));
    if (fl.length === 1) return { match: fl[0] };
    if (fl.length > 1) return { ambiguous: fl };
  }
  if (lastOnly.length > 1) return { ambiguous: lastOnly };
  return { none: true };
}

/** Parse "TAKEN: A, B, C" / newline / semicolon separated lists. */
export function parseNameList(text) {
  return String(text || '')
    .replace(/^\s*(taken|drafted|gone)\s*:\s*/i, '')
    .split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

// ---------- Category value model (z-scores) ----------
const COUNTING = ['tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];

function mean(a) { return a.reduce((s, x) => s + x, 0) / (a.length || 1); }
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length || 1)) || 1; }

/**
 * Compute per-category z-scores for every player.
 * - Counting stats: z of per-game value (optionally scaled by games played / 82).
 * - Percentages: impact = (pct - poolAvgPct) * attempts, then z of impact (volume-aware).
 * - Turnovers: sign flipped so fewer = better.
 * - Players with a missing stat get z = 0 for that cat (no artificial advantage) and `missing` listed.
 * The pool used for mean/SD is the top `poolSize` players by a first-pass total, so the baseline is
 * "a draftable player", not the whole NBA.
 */
export function computeValues(players, opts = {}) {
  const poolSize = opts.poolSize ?? 130;
  const gpWeight = opts.gpWeight ?? true;
  const weights = opts.weights ?? {};
  const scale = p => (gpWeight && p.gp ? Math.min(p.gp, 82) / 82 : 1);

  const stat = (p, k) => (typeof p[k] === 'number' && !Number.isNaN(p[k]) ? p[k] : null);

  function pass(pool) {
    const poolFga = pool.map(p => stat(p, 'fga') ?? 0);
    const poolFta = pool.map(p => stat(p, 'fta') ?? 0);
    const avgFgp = pool.reduce((s, p) => s + (stat(p, 'fgp') ?? 0) * (stat(p, 'fga') ?? 0), 0) / (poolFga.reduce((a, b) => a + b, 0) || 1);
    const avgFtp = pool.reduce((s, p) => s + (stat(p, 'ftp') ?? 0) * (stat(p, 'fta') ?? 0), 0) / (poolFta.reduce((a, b) => a + b, 0) || 1);
    const impact = (p, pk, ak, avg) => {
      const v = stat(p, pk), a = stat(p, ak);
      return v == null || a == null ? null : (v - avg) * a;
    };
    const raw = {};
    for (const k of COUNTING) raw[k] = pool.map(p => { const v = stat(p, k); return v == null ? null : v * scale(p); });
    raw.fgp = pool.map(p => { const v = impact(p, 'fgp', 'fga', avgFgp); return v == null ? null : v * scale(p); });
    raw.ftp = pool.map(p => { const v = impact(p, 'ftp', 'fta', avgFtp); return v == null ? null : v * scale(p); });
    const stats = {};
    for (const k of Object.keys(raw)) {
      const vals = raw[k].filter(v => v != null);
      stats[k] = { m: mean(vals), s: sd(vals) };
    }
    return { stats, avgFgp, avgFtp };
  }

  function zFor(p, model) {
    const z = {}; const missing = [];
    for (const c of CATS) {
      let v;
      if (c.pct) {
        const pv = stat(p, c.key), a = stat(p, c.att);
        v = pv == null || a == null ? null : (pv - (c.key === 'fgp' ? model.avgFgp : model.avgFtp)) * a * scale(p);
      } else {
        const pv = stat(p, c.key);
        v = pv == null ? null : pv * scale(p);
      }
      if (v == null) { z[c.key] = 0; missing.push(c.key); continue; }
      let zz = (v - model.stats[c.key].m) / model.stats[c.key].s;
      if (!c.higherIsBetter) zz = -zz;
      z[c.key] = zz;
    }
    return { z, missing };
  }

  const total = (z) => CATS.reduce((s, c) => s + (weights[c.key] ?? 1) * z[c.key], 0);

  // First pass over everyone, pick the pool, second pass with the pool baseline.
  let model = pass(players);
  let scored = players.map(p => ({ p, ...zFor(p, model) }));
  scored.sort((a, b) => total(b.z) - total(a.z));
  const pool = scored.slice(0, Math.min(poolSize, scored.length)).map(s => s.p);
  model = pass(pool);
  const out = players.map(p => {
    const { z, missing } = zFor(p, model);
    return { ...p, z, missing, value: total(z), fallback: missing.length > 0 };
  });
  out.sort((a, b) => b.value - a.value);
  out.forEach((p, i) => { p.modelRank = i + 1; });
  return out;
}

// ---------- Roster / slots ----------
export function canFillSlot(slot, positions) {
  const elig = SLOT_ELIGIBILITY[slot];
  if (elig === null) return true;
  return positions.some(pos => elig.includes(pos));
}

/**
 * Greedy-with-backtracking assignment of players to slots. Returns { assignments: {slot_i: player}, unfilled: [slots], overflow: [players] }.
 * Tries to place every player; specific slots are filled before flex slots.
 */
export function assignRoster(players, slots = LEAGUE.slots) {
  const order = slots.map((s, i) => ({ s, i }));
  const specificity = s => (SLOT_ELIGIBILITY[s] === null ? 9 : SLOT_ELIGIBILITY[s].length);
  const assignment = new Array(slots.length).fill(null);
  const placed = new Set();
  // Sort players by how few slots they can fill (most constrained first)
  const sorted = [...players].sort((a, b) => {
    const ca = order.filter(o => canFillSlot(o.s, a.positions)).length;
    const cb = order.filter(o => canFillSlot(o.s, b.positions)).length;
    return ca - cb;
  });
  function tryPlace(idx) {
    if (idx >= sorted.length) return true;
    const pl = sorted[idx];
    const candidates = order.filter(o => assignment[o.i] === null && canFillSlot(o.s, pl.positions))
      .sort((x, y) => specificity(x.s) - specificity(y.s));
    for (const c of candidates) {
      assignment[c.i] = pl; placed.add(pl);
      if (tryPlace(idx + 1)) return true;
      assignment[c.i] = null; placed.delete(pl);
    }
    // could not place this player anywhere: skip (overflow) and continue
    return tryPlace(idx + 1);
  }
  tryPlace(0);
  const assignments = slots.map((s, i) => ({ slot: s, player: assignment[i] }));
  const unfilled = assignments.filter(a => !a.player).map(a => a.slot);
  const overflow = players.filter(p => !placed.has(p));
  return { assignments, unfilled, overflow };
}

export function openSlots(roster, slots = LEAGUE.slots) {
  return assignRoster(roster, slots).unfilled;
}

/** Sum of z per category for a roster. */
export function teamProfile(roster) {
  const prof = {};
  for (const c of CATS) prof[c.key] = roster.reduce((s, p) => s + (p.z?.[c.key] ?? 0), 0);
  return prof;
}

// ---------- Recommendation ----------
/**
 * Score available players for THIS roster. Returns sorted candidates with reasons.
 * opts: { punts: ['ftp'], nextPick, currentPick, numTeams, rosterSlots }
 */
export function recommend(available, roster, opts = {}) {
  const punts = new Set(opts.punts || []);
  const slots = opts.rosterSlots || LEAGUE.slots;
  const open = openSlots(roster, slots);
  const prof = teamProfile(roster);
  const nextPick = opts.nextPick ?? null;
  const currentPick = opts.currentPick ?? null;
  const rosterCount = roster.length;
  const draftProgress = rosterCount / slots.length; // 0..1

  // Need weights: the more negative a category total is relative to roster size, the more a contribution there is worth.
  // Scale shrinks early (little info) and grows mid-draft. Punted categories get 0.
  const needWeight = {};
  for (const c of CATS) {
    if (punts.has(c.key)) { needWeight[c.key] = 0; continue; }
    const perPlayer = rosterCount ? prof[c.key] / rosterCount : 0; // avg z per rostered player
    const need = Math.max(-1.5, Math.min(1.5, -perPlayer)); // weak cat => positive need
    needWeight[c.key] = 1 + 0.35 * need * Math.min(1, rosterCount / 4);
  }

  const centresOpen = open.filter(s => s === 'C').length;
  const guardsOpen = open.filter(s => ['PG', 'SG', 'G'].includes(s)).length;
  const fwdOpen = open.filter(s => ['SF', 'PF', 'F'].includes(s)).length;
  const flexOpen = open.filter(s => ['Util', 'BN'].includes(s)).length;

  const cands = available.map(p => {
    const fitZ = CATS.reduce((s, c) => s + needWeight[c.key] * (p.z?.[c.key] ?? 0), 0);
    const baseZ = CATS.reduce((s, c) => s + (punts.has(c.key) ? 0 : (p.z?.[c.key] ?? 0)), 0);
    let score = fitZ;
    const reasons = [];
    const flags = [];

    // Position fit
    const fillsSpecific = open.some(s => SLOT_ELIGIBILITY[s] && canFillSlot(s, p.positions));
    const fillsAny = open.some(s => canFillSlot(s, p.positions));
    if (!fillsAny) { score -= 3; flags.push('No open slot fits this player'); }
    else if (!fillsSpecific && flexOpen <= 1 && open.length > 0) { score -= 0.5; flags.push('Only a flex/bench slot fits'); }
    if (p.positions.includes('C') && centresOpen > 0 && draftProgress >= 0.4) { score += 0.35 * centresOpen; reasons.push(`Fills an open C slot (${centresOpen} open)`); }
    if (!p.positions.includes('C') && centresOpen >= 2 && draftProgress >= 0.6 && open.length <= 5) { score -= 0.5; flags.push('Two C slots still open'); }

    // Availability risk / injuries
    if (p.gp != null && p.gp < 55) { flags.push(`Projected ~${p.gp} games`); }
    if (p.risk) flags.push(p.risk);

    // ADP / value & survive-to-next-pick
    let adpNote = null; let likelyGone = null;
    if (typeof p.adp === 'number' && currentPick) {
      const diff = p.adp - currentPick;
      adpNote = diff >= 8 ? `Value: ADP ~${p.adp} vs pick ${currentPick}` : diff <= -8 ? `Reach: ADP ~${p.adp} vs pick ${currentPick}` : `Fair: ADP ~${p.adp}`;
      if (nextPick) likelyGone = p.adp < nextPick - 3;
      if (likelyGone === true) score += 0.25; // taking players who will not survive is how value is captured
      if (likelyGone === false && nextPick - currentPick > 3) score -= 0.15;
    }

    // Top category contributions for the "why"
    const contribs = CATS.filter(c => !punts.has(c.key)).map(c => ({ c, z: p.z?.[c.key] ?? 0 }))
      .sort((a, b) => b.z - a.z);
    const strengths = contribs.filter(x => x.z >= 0.6).slice(0, 4).map(x => x.c.label);
    const weaknesses = contribs.filter(x => x.z <= -0.8).map(x => x.c.label);
    const helpsNeeds = contribs.filter(x => x.z >= 0.5 && needWeight[x.c.key] > 1.1).map(x => x.c.label);
    if (strengths.length) reasons.unshift(`Elite/strong in ${strengths.join(', ')}`);
    if (helpsNeeds.length) reasons.push(`Shores up your weak cats: ${helpsNeeds.join(', ')}`);
    if (p.note) reasons.push(p.note);

    return { player: p, score, baseZ, fitZ, reasons: reasons.slice(0, 3), flags, strengths, weaknesses, adpNote, likelyGone };
  });
  cands.sort((a, b) => b.score - a.score);

  const best = cands[0] || null;
  let confidence = 'low', confidenceWhy = 'No candidates';
  if (best) {
    const gap = cands[1] ? best.score - cands[1].score : 1;
    const missing = best.player.missing?.length || 0;
    if (gap >= 0.6 && missing === 0 && !best.player.risk) { confidence = 'high'; confidenceWhy = 'Clear gap to next option and no major risk flag'; }
    else if (gap >= 0.25 || (!best.player.risk && missing === 0)) { confidence = 'medium'; confidenceWhy = gap < 0.25 ? 'Close call with the backups' : (best.player.risk ? 'Reasonable gap but carries a risk flag' : 'Moderate gap to the backups'); }
    else { confidence = 'low'; confidenceWhy = 'Close call and/or risk flag — backups are nearly as good'; }
  }
  return { candidates: cands, best, backups: cands.slice(1, 3), confidence, confidenceWhy, open, needWeight, profile: prof };
}

// ---------- Draft state ----------
export function createState(overrides = {}) {
  return {
    numTeams: LEAGUE.teams,
    mySlot: null,
    teamNames: Array.from({ length: LEAGUE.teams }, (_, i) => `Team ${i + 1}`),
    picks: [], // { overall, playerId, slot }
    punts: [],
    gpWeight: true,
    removed: [], // player ids manually removed (e.g. "not in this player pool")
    ...overrides,
  };
}

export function currentOverall(state) { return state.picks.length + 1; }
export function isMyTurn(state) { return state.mySlot != null && teamOnClock(currentOverall(state), state.numTeams) === state.mySlot; }
export function draftedIds(state) { return new Set(state.picks.map(p => p.playerId)); }
export function myRoster(state, players) {
  const byId = new Map(players.map(p => [p.id, p]));
  return state.picks.filter(p => p.slot === state.mySlot).map(p => byId.get(p.playerId)).filter(Boolean);
}
export function rosterForSlot(state, players, slot) {
  const byId = new Map(players.map(p => [p.id, p]));
  return state.picks.filter(p => p.slot === slot).map(p => byId.get(p.playerId)).filter(Boolean);
}
export function availablePlayers(state, players) {
  const gone = draftedIds(state); const removed = new Set(state.removed || []);
  return players.filter(p => !gone.has(p.id) && !removed.has(p.id));
}

/** Immutable draft: returns a new state, or throws for duplicates / completed drafts. */
export function draftPlayer(state, playerId, opts = {}) {
  if (draftedIds(state).has(playerId)) throw new Error('Player already drafted');
  const overall = currentOverall(state);
  const maxPicks = state.numTeams * ROSTER_SIZE;
  if (overall > maxPicks) throw new Error('Draft is complete');
  const slot = opts.slot ?? teamOnClock(overall, state.numTeams);
  return { ...state, picks: [...state.picks, { overall, playerId, slot }] };
}
export function undoLastPick(state) {
  if (!state.picks.length) return state;
  return { ...state, picks: state.picks.slice(0, -1) };
}
