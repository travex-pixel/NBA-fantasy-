// Fetch live 2026-27 NBA per-game stats and the injury report from ESPN's public JSON APIs and write
// data/live-stats.json: { source, season, fetchedAt, count, players: {name: perGame}, injuries: {name: {...}} }.
// Needs the environment to allow site.web.api.espn.com (stats) and site.api.espn.com (injuries).
// Usage: node scripts/fetch-espn.mjs [--season 2027] [--stats-fixture f.json] [--injury-fixture f.json] [--out data/live-stats.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const season = args.season || '2027'; // ESPN uses the season END year: 2026-27 => 2027
const out = args.out || 'data/live-stats.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Accept': 'application/json' };
const STATS_URL = (page) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=1000&page=${page}&season=${season}&seasontype=2`;
const INJ_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const ct = res.headers.get('content-type') || '';
  if (!/json/.test(ct)) throw new Error(`non-JSON response (${ct}) from ${url} — likely a bot challenge or policy block`);
  return res.json();
}

// Map ESPN stat names -> our keys. Looked up by name so column order never matters.
const WANT = { gamesPlayed: 'gp', avgMinutes: 'min', avgPoints: 'pts', avgRebounds: 'reb', avgAssists: 'ast', avgSteals: 'stl', avgBlocks: 'blk', avgThreePointFieldGoalsMade: 'tpm', avgFieldGoalsMade: 'fgm', avgFieldGoalsAttempted: 'fga', avgFreeThrowsMade: 'ftm', avgFreeThrowsAttempted: 'fta', avgTurnovers: 'tov' };

/** Normalise ESPN byathlete payload(s) into {name: perGame}. Exported for tests. */
export function normaliseStats(pages) {
  const players = {};
  for (const json of [].concat(pages)) {
    const cats = json?.categories; const athletes = json?.athletes;
    if (!Array.isArray(cats) || !Array.isArray(athletes)) throw new Error('unexpected ESPN stats payload shape');
    // categories[i].names lists the stat ids for athletes[j].categories[i].values
    const index = cats.map(c => Object.fromEntries((c.names || []).map((n, i) => [n, i])));
    const found = new Set(cats.flatMap(c => c.names || []).filter(n => n in WANT));
    const missing = Object.keys(WANT).filter(n => !found.has(n));
    if (missing.length) throw new Error('ESPN stats missing fields: ' + missing.join(','));
    for (const a of athletes) {
      const name = a?.athlete?.displayName; if (!name) continue;
      const row = { team: a.athlete.teamShortName || a.athlete.team?.abbreviation || null, pos: a.athlete.position?.abbreviation || null };
      (a.categories || []).forEach((c, ci) => { for (const [n, k] of Object.entries(WANT)) { const i = index[ci]?.[n]; if (i != null && c.values?.[i] != null) row[k] = Number(c.values[i]); } });
      if (typeof row.gp !== 'number' || Number.isNaN(row.gp)) continue;
      players[name] = row;
    }
  }
  return players;
}

/** Normalise ESPN injuries payload into {name: {team, status, type, detail, returnDate, comment}}. Exported for tests. */
export function normaliseInjuries(json) {
  const teams = json?.injuries; if (!Array.isArray(teams)) throw new Error('unexpected ESPN injuries payload shape');
  const out = {};
  for (const t of teams) for (const inj of t.injuries || []) {
    const name = inj?.athlete?.displayName; if (!name) continue;
    out[name] = { team: t.displayName || t.abbreviation || null, status: inj.status || inj.details?.fantasyStatus?.description || null, type: inj.details?.type || inj.type?.description || null, detail: inj.details?.detail || null, returnDate: inj.details?.returnDate || null, comment: inj.shortComment || null, date: inj.date || null };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let statsPages, injJson, errors = [];
  if (args['stats-fixture']) statsPages = [JSON.parse(readFileSync(args['stats-fixture'], 'utf8'))];
  else { statsPages = []; for (let p = 1; p <= 3; p++) { const j = await getJson(STATS_URL(p)); statsPages.push(j); const pc = j?.pagination?.pages ?? 1; if (p >= pc) break; } }
  const players = normaliseStats(statsPages);
  let injuries = {};
  try { injJson = args['injury-fixture'] ? JSON.parse(readFileSync(args['injury-fixture'], 'utf8')) : await getJson(INJ_URL); injuries = normaliseInjuries(injJson); }
  catch (e) { errors.push('injuries: ' + e.message); }
  const payload = { source: args['stats-fixture'] ? 'fixture' : 'ESPN site.web.api.espn.com byathlete (per game) + site.api.espn.com injuries', season: `${Number(season) - 1}-${String(season).slice(2)}`, fetchedAt: new Date().toISOString(), count: Object.keys(players).length, injuryCount: Object.keys(injuries).length, errors, players, injuries };
  mkdirSync('data', { recursive: true });
  writeFileSync(out, JSON.stringify(payload));
  console.log(`wrote ${out}: ${payload.count} players, ${payload.injuryCount} injuries (${payload.source})${errors.length ? ' errors: ' + errors.join('; ') : ''}`);
}
