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
    if (p.injury) {
      const st = String(p.injury.status || '').toLowerCase();
      const isOut = /out/.test(st) && !/doubt/.test(st);
      flags.push(`${p.injury.status || 'Injury'}${p.injury.type ? ' (' + p.injury.type + ')' : ''}${p.injury.returnDate ? ', est. return ' + p.injury.returnDate : ''}`);
      score -= isOut ? 0.8 : /doubtful/.test(st) ? 0.4 : 0.1;
    }
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

// ---------- Live stats blending ----------
/**
 * Attach live 2026-27 per-game stats to pool players (matched by normalised name) and produce a
 * blended projection: blended = (preseason * K + live * gp) / (K + gp). K = how many games the
 * preseason estimate is "worth"; with K=25 a player with 25 games played is weighted 50/50.
 * Percentages are blended on made/attempted volume so a 3-of-4 night cannot swing FG% much.
 * Returns NEW player objects; originals are untouched. Players without a live match keep their
 * preseason line and have live = null. Nothing is invented for missing live fields.
 */
export function applyLiveStats(players, liveMap, opts = {}) {
  const K = opts.k ?? 25;
  const use = opts.use ?? true;
  const idx = new Map();
  for (const [name, row] of Object.entries(liveMap || {})) idx.set(normaliseName(name), row);
  const injIdx = new Map();
  for (const [name, row] of Object.entries(opts.injuries || {})) injIdx.set(normaliseName(name), row);
  let matched = 0;
  const out = players.map(p => {
    const live = idx.get(normaliseName(p.name)) || null;
    const injury = injIdx.get(normaliseName(p.name)) || null;
    if (!live || !(live.gp > 0)) return { ...p, live: null, injury, preseason: p.preseason || null };
    matched++;
    const gp = live.gp;
    const w = K / (K + gp), v = gp / (K + gp);
    const pre = p.preseason || { pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, tpm: p.tpm, fgp: p.fgp, fga: p.fga, ftp: p.ftp, fta: p.fta, tov: p.tov, gp: p.gp };
    if (!use) return { ...p, ...pre, live, injury, preseason: pre };
    const b = {};
    for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'tov']) b[k] = typeof live[k] === 'number' ? +(pre[k] * w + live[k] * v).toFixed(2) : pre[k];
    // volume-weighted percentage blend
    const fga = typeof live.fga === 'number' ? pre.fga * w + live.fga * v : pre.fga;
    const fta = typeof live.fta === 'number' ? pre.fta * w + live.fta * v : pre.fta;
    const fgm = pre.fgp * pre.fga * w + (typeof live.fgm === 'number' ? live.fgm : pre.fgp * pre.fga) * v;
    const ftm = pre.ftp * pre.fta * w + (typeof live.ftm === 'number' ? live.ftm : pre.ftp * pre.fta) * v;
    b.fga = +fga.toFixed(2); b.fta = +fta.toFixed(2);
    b.fgp = fga > 0 ? +(fgm / fga).toFixed(3) : pre.fgp;
    b.ftp = fta > 0 ? +(ftm / fta).toFixed(3) : pre.ftp;
    return { ...p, ...b, live, injury, preseason: pre };
  });
  return { players: out, matched, unmatched: players.length - matched };
}

// ---------- Season calendar, schedule and weekly projection ----------
/** ESPN team codes -> the codes used in data.js / Yahoo. */
export const ESPN_TEAM_MAP = { GS: 'GSW', SA: 'SAS', NY: 'NYK', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
export function normTeam(t) { return ESPN_TEAM_MAP[t] || t; }

/** Game dates are stored as US-Eastern calendar dates (YYYY-MM-DD), which is how Yahoo scores a "day". */
export function etDateOf(isoUtc) {
  const d = new Date(isoUtc);
  const y = d.getUTCFullYear();
  // US DST: second Sunday of March 2am -> first Sunday of November 2am (approximate with UTC dates)
  const nthSunday = (year, month, n) => { const first = new Date(Date.UTC(year, month, 1)); const day = first.getUTCDay(); return 1 + ((7 - day) % 7) + 7 * (n - 1); };
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7); // 2am EST = 07:00 UTC
  const dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); // 2am EDT = 06:00 UTC
  const offsetH = d.getTime() >= dstStart && d.getTime() < dstEnd ? 4 : 5;
  const local = new Date(d.getTime() - offsetH * 3600000);
  return local.toISOString().slice(0, 10);
}

/** Yahoo fantasy weeks for 2026-27. Week 1 is the short opening week; week 2 onward run Monday to Sunday.
 *  Note: Yahoo sometimes merges the All-Star week into a two-week period; this calendar does not, so
 *  numbering after mid-February is approximate until confirmed against the league page. */
export const SEASON = { week1Start: '2026-10-20', week2Start: '2026-10-26', playoffWeeks: [20, 21, 22], scoringStartsWeek: 2 };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function weekRange(week) {
  if (week <= 1) return { week: 1, start: SEASON.week1Start, end: addDays(SEASON.week2Start, -1) };
  const start = addDays(SEASON.week2Start, (week - 2) * 7);
  return { week, start, end: addDays(start, 6) };
}
export function weekOf(dateStr) {
  if (dateStr < SEASON.week2Start) return weekRange(1);
  const days = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(SEASON.week2Start + 'T00:00:00Z')) / 86400000);
  return weekRange(2 + Math.floor(days / 7));
}

/** schedule = { teams: { CODE: [[dateET, oppCode, home(1|0)], ...] } } */
export function gamesFor(schedule, team, start, end) {
  const list = schedule?.teams?.[normTeam(team)] || [];
  return list.filter(g => g[0] >= start && g[0] <= end).map(g => ({ date: g[0], opp: g[1], home: !!g[2] }));
}
export function playoffGames(schedule, team) {
  return SEASON.playoffWeeks.reduce((s, w) => { const r = weekRange(w); return s + gamesFor(schedule, team, r.start, r.end).length; }, 0);
}

function injuryOut(p, end) {
  const st = String(p.injury?.status || '').toLowerCase();
  if (!st) return false;
  if (/out|doubt/.test(st) && !/day/.test(st)) { const rd = p.injury?.returnDate; return !rd || rd > end; }
  return false;
}

/** Project a roster's category totals over a date range from per-game rates and the schedule.
 *  Players with status Out (and no return inside the range) count zero games. Returns per-player games,
 *  totals (counting stats, makes/attempts and the derived percentages) and a per-category variance. */
export function projectWeek(players, schedule, { start, end, fromDate = null, slots = LEAGUE.slots.slice(0, 10) } = {}) {
  // Yahoo only counts players in the ten starting slots each day. For each date, start the most valuable
  // healthy players who have a game, subject to slot eligibility (PG, SG, G, SF, PF, F, C, C, Util, Util).
  const totals = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
  const variance = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, tov: 0 };
  const info = new Map(players.map(p => [p, { player: p, games: 0, dates: [], benched: 0, out: injuryOut(p, end), gtd: /day|questionable|game time/i.test(p.injury?.status || '') }]));
  const days = [];
  for (let d = fromDate && fromDate > start ? fromDate : start; d <= end; d = addDays(d, 1)) days.push(d);
  const rank = p => (typeof p.value === 'number' ? p.value : 0);
  for (const d of days) {
    const playing = players.filter(p => !injuryOut(p, d) && gamesFor(schedule, p.team, d, d).length).sort((a, b) => rank(b) - rank(a));
    const starters = [];
    for (const p of playing) {
      if (!p.positions?.length) { if (starters.length < slots.length) starters.push(p); continue; }
      const trial = [...starters, p];
      if (assignRoster(trial, slots).overflow.length === 0) starters.push(p); else info.get(p).benched++;
    }
    for (const p of starters) {
      const x = info.get(p); x.games++; x.dates.push(d);
      for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'tov']) { const r = p[k] || 0; totals[k] += r; variance[k] += Math.pow(0.45 * r + 0.3, 2); }
      totals.fgm += (p.fgp || 0) * (p.fga || 0); totals.fga += p.fga || 0;
      totals.ftm += (p.ftp || 0) * (p.fta || 0); totals.fta += p.fta || 0;
    }
  }
  totals.fgp = totals.fga ? totals.fgm / totals.fga : 0; totals.ftp = totals.fta ? totals.ftm / totals.fta : 0;
  variance.fgp = totals.fga ? (totals.fgp * (1 - totals.fgp)) / totals.fga : 0;
  variance.ftp = totals.fta ? (totals.ftp * (1 - totals.ftp)) / totals.fta : 0;
  const perPlayer = [...info.values()];
  return { perPlayer, totals, variance, games: perPlayer.reduce((s, x) => s + x.games, 0) };
}

/** Add actual week-to-date totals (from Yahoo's matchup screen) to a rest-of-week projection.
 *  actual: { fgm, fga, ftm, fta, tpm, pts, reb, ast, stl, blk, tov } */
export function addActuals(proj, actual) {
  const t = { ...proj.totals };
  for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'tov', 'fgm', 'fga', 'ftm', 'fta']) t[k] = (t[k] || 0) + (actual?.[k] || 0);
  t.fgp = t.fga ? t.fgm / t.fga : 0; t.ftp = t.fta ? t.ftm / t.fta : 0;
  const v = { ...proj.variance };
  v.fgp = t.fga ? (t.fgp * (1 - t.fgp)) * (proj.totals.fga || 0) / (t.fga * t.fga) : 0;
  v.ftp = t.fta ? (t.ftp * (1 - t.ftp)) * (proj.totals.fta || 0) / (t.fta * t.fta) : 0;
  return { ...proj, totals: t, variance: v };
}

function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x >= 0 ? 1 - p : p; }

/** Compare two weekly projections category by category. label: locked (>=80%), lean (65-80), swing (35-65), behind (20-35), lost (<20). */
export function compareWeek(mine, theirs) {
  return CATS.map(c => {
    const a = mine.totals[c.key], b = theirs.totals[c.key];
    const sd = Math.sqrt((mine.variance[c.key] || 0) + (theirs.variance[c.key] || 0)) || 1e-6;
    let z = (a - b) / sd; if (!c.higherIsBetter) z = -z;
    const p = normCdf(z);
    const label = p >= 0.8 ? 'locked' : p >= 0.65 ? 'lean' : p > 0.35 ? 'swing' : p > 0.2 ? 'behind' : 'lost';
    return { key: c.key, label: c.label, mine: a, theirs: b, pWin: p, state: label };
  });
}

/** Which categories to chase this week: swing and behind categories carry full weight, lean half, locked and lost none. */
export function needWeights(cmp) {
  const w = {}; for (const r of cmp) w[r.key] = r.state === 'swing' || r.state === 'behind' ? 1 : r.state === 'lean' ? 0.5 : 0; return w;
}

/** Rank free agents for streaming: category value in the needed categories times games left in the range. */
export function streamCandidates(freeAgents, schedule, { start, end, fromDate = null }, weights) {
  return freeAgents.map(p => {
    const all = gamesFor(schedule, p.team, start, end); const left = (fromDate ? all.filter(g => g.date >= fromDate) : all);
    const games = injuryOut(p, end) ? 0 : left.length;
    const fit = CATS.reduce((s, c) => s + (weights[c.key] || 0) * (p.z?.[c.key] || 0), 0);
    return { player: p, games, dates: left.map(g => g.date), fit, score: games * (fit + 0.5) };
  }).sort((a, b) => b.score - a.score);
}

/** Players with a game on a given ET date, with injury flags. */
export function playingOn(players, schedule, dateET) {
  return players.map(p => ({ player: p, plays: gamesFor(schedule, p.team, dateET, dateET).length > 0, out: injuryOut(p, dateET), gtd: /day|questionable|game time/i.test(p.injury?.status || '') }));
}

// ---------- Recent form from game logs ----------
/** gamelog rows: [dateET, min, pts, reb, ast, stl, blk, tpm, fgm, fga, ftm, fta, tov] newest first. */
export function recentAverages(rows, n = 10) {
  const g = (rows || []).filter(r => r && r[1] > 0).slice(0, n);
  if (!g.length) return null;
  const sum = i => g.reduce((s, r) => s + (r[i] || 0), 0);
  const L = g.length;
  const fga = sum(9) / L, fta = sum(11) / L;
  return { gp: L, min: sum(1) / L, pts: sum(2) / L, reb: sum(3) / L, ast: sum(4) / L, stl: sum(5) / L, blk: sum(6) / L, tpm: sum(7) / L, fga, fta, fgp: fga ? sum(8) / sum(9) : null, ftp: fta ? sum(10) / sum(11) : null, tov: sum(12) / L };
}
/** Blend the last-n form into each player's current line with weight n/(n+k). Idempotent (uses .preseason/.live baseline when present). */
export function applyRecentForm(players, gamelogs, { n = 10, k = 10, use = true } = {}) {
  const idx = new Map(); for (const [name, rows] of Object.entries(gamelogs || {})) idx.set(normaliseName(name), rows);
  let matched = 0;
  const out = players.map(p => {
    const rows = idx.get(normaliseName(p.name)); const form = rows ? recentAverages(rows, n) : null;
    if (!form) return { ...p, form: null };
    matched++;
    if (!use) return { ...p, form };
    const base = p.formBase || { pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, tpm: p.tpm, fgp: p.fgp, fga: p.fga, ftp: p.ftp, fta: p.fta, tov: p.tov };
    const w = form.gp / (form.gp + k), v = 1 - w; const b = {};
    for (const key of ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'tov', 'fga', 'fta']) b[key] = +(base[key] * v + form[key] * w).toFixed(2);
    b.fgp = form.fgp == null ? base.fgp : +(((base.fgp * base.fga * v) + (form.fgp * form.fga * w)) / (b.fga || 1)).toFixed(3);
    b.ftp = form.ftp == null ? base.ftp : +(((base.ftp * base.fta * v) + (form.ftp * form.fta * w)) / (b.fta || 1)).toFixed(3);
    return { ...p, ...b, form, formBase: base };
  });
  return { players: out, matched };
}
