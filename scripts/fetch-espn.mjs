// Fetch live 2026-27 NBA per-game stats and the injury report from ESPN's public JSON APIs and write
// data/live-stats.json: { source, season, fetchedAt, count, players: {name: perGame}, injuries: {name: {...}} }.
// Needs the environment to allow site.web.api.espn.com (stats) and site.api.espn.com (injuries).
// Usage: node scripts/fetch-espn.mjs [--season 2027] [--stats-fixture f.json] [--injury-fixture f.json] [--out data/live-stats.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set at startup (Node >= 22.21).
// In the cloud environment every outbound request must go through that proxy, so re-exec ourselves with it set.
if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== '1' && !process.argv.includes('--no-reexec')) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const season = args.season || '2027'; // ESPN uses the season END year: 2026-27 => 2027
const out = args.out || 'data/live-stats.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Accept': 'application/json' };
const STATS_URL = (page) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=1000&page=${page}&season=${season}&seasontype=2`;
const INJ_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams';
const TEAM_SCHED_URL = (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/schedule?season=${season}`;
const GAMELOG_URL = (id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=${season}`;
const ESPN_TEAM_MAP = { GS: 'GSW', SA: 'SAS', NY: 'NYK', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
const normTeam = t => ESPN_TEAM_MAP[t] || t;
/** UTC ISO -> US Eastern calendar date (Yahoo scores by ET day). */
export function etDateOf(isoUtc) {
  const d = new Date(isoUtc); const y = d.getUTCFullYear();
  const nthSunday = (year, month, n) => { const first = new Date(Date.UTC(year, month, 1)); return 1 + ((7 - first.getUTCDay()) % 7) + 7 * (n - 1); };
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  const off = d.getTime() >= dstStart && d.getTime() < dstEnd ? 4 : 5;
  return new Date(d.getTime() - off * 3600000).toISOString().slice(0, 10);
}
/** Team schedule payload -> [[dateET, oppCode, home], ...] regular season only. Exported for tests. */
export function normaliseSchedule(json, teamCode) {
  const out = [];
  for (const ev of json?.events || []) {
    if ((ev.seasonType?.type ?? 2) !== 2) continue;
    const comp = ev.competitions?.[0]; if (!comp) continue;
    const me = comp.competitors?.find(c => normTeam(c.team?.abbreviation) === teamCode);
    const opp = comp.competitors?.find(c => normTeam(c.team?.abbreviation) !== teamCode);
    if (!me || !opp) continue;
    out.push([etDateOf(ev.date), normTeam(opp.team.abbreviation), me.homeAway === 'home' ? 1 : 0]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}
/** Gamelog payload -> rows [dateET, min, pts, reb, ast, stl, blk, tpm, fgm, fga, ftm, fta, tov] newest first, regular season only, max `keep`. Exported for tests. */
export function normaliseGamelog(json, keep = 10) {
  const names = json?.names; if (!Array.isArray(names)) throw new Error('unexpected gamelog shape');
  const ix = Object.fromEntries(names.map((n, i) => [n, i]));
  const need = ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted', 'totalRebounds', 'assists', 'blocks', 'steals', 'turnovers', 'points'];
  for (const n of need) if (!(n in ix)) throw new Error('gamelog missing ' + n);
  const split = s => String(s).split('-').map(Number);
  const rows = [];
  for (const st of json.seasonTypes || []) {
    if (!/regular/i.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) for (const e of cat.events || []) {
      const ev = json.events?.[e.eventId]; const s = e.stats || [];
      const [fgm, fga] = split(s[ix['fieldGoalsMade-fieldGoalsAttempted']]); const [tpm] = split(s[ix['threePointFieldGoalsMade-threePointFieldGoalsAttempted']]); const [ftm, fta] = split(s[ix['freeThrowsMade-freeThrowsAttempted']]);
      rows.push([ev?.gameDate ? etDateOf(ev.gameDate) : null, Number(s[ix.minutes]) || 0, Number(s[ix.points]) || 0, Number(s[ix.totalRebounds]) || 0, Number(s[ix.assists]) || 0, Number(s[ix.steals]) || 0, Number(s[ix.blocks]) || 0, tpm || 0, fgm || 0, fga || 0, ftm || 0, fta || 0, Number(s[ix.turnovers]) || 0]);
    }
  }
  rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  return rows.slice(0, keep);
}
async function mapLimit(items, limit, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } } })); return out; }

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
  let players = normaliseStats(statsPages); let statsNote = null;
  // Guard against ESPN serving a previous season under the requested label (it does this before tip-off):
  // no player can have more games played than days elapsed since opening night (21 Oct 2026) + 1.
  const first = statsPages[0] || {};
  const reqYear = first?.requestedSeason?.year ?? first?.season?.year ?? null;
  const opening = Date.UTC(2026, 9, 21); const daysIn = Math.floor((Date.now() - opening) / 86400000) + 1;
  const maxGp = Math.max(0, ...Object.values(players).map(r => r.gp || 0));
  if (!args['stats-fixture'] && reqYear != null && String(reqYear) !== String(season)) { statsNote = `ESPN returned season ${reqYear}, not ${season} (2026-27 stats not available yet); stats omitted`; players = {}; }
  else if (!args['stats-fixture'] && maxGp > Math.max(1, daysIn + 1)) { statsNote = `stats look stale: a player shows ${maxGp} games but only ${Math.max(0, daysIn)} day(s) of 2026-27 have been played; stats omitted`; players = {}; }
  let injuries = {};
  try { injJson = args['injury-fixture'] ? JSON.parse(readFileSync(args['injury-fixture'], 'utf8')) : await getJson(INJ_URL); injuries = normaliseInjuries(injJson); }
  catch (e) { errors.push('injuries: ' + e.message); }
  // --- schedule (30 teams) and game logs (players with minutes) ---
  const schedOut = args['schedule-out'] || 'data/schedule.json'; const logsOut = args['gamelogs-out'] || 'data/gamelogs.json';
  if (!args['stats-fixture'] && !args['skip-extras']) {
    try {
      const teams = (await getJson(TEAMS_URL))?.sports?.[0]?.leagues?.[0]?.teams?.map(t => ({ id: t.team.id, code: normTeam(t.team.abbreviation) })) || [];
      if (teams.length < 30) throw new Error('teams list short: ' + teams.length);
      const scheds = await mapLimit(teams, 6, async t => [t.code, normaliseSchedule(await getJson(TEAM_SCHED_URL(t.id)), t.code)]);
      const sched = { fetchedAt: new Date().toISOString(), season: `${Number(season) - 1}-${String(season).slice(2)}`, teams: Object.fromEntries(scheds.filter(x => Array.isArray(x))) };
      writeFileSync(schedOut, JSON.stringify(sched));
      console.log(`wrote ${schedOut}: ${Object.keys(sched.teams).length} teams, ${Object.values(sched.teams).reduce((a, b) => a + b.length, 0)} games`);
    } catch (e) { errors.push('schedule: ' + e.message); }
    try {
      const ids = []; for (const j of statsPages) for (const a of j.athletes || []) { const n = a?.athlete?.displayName; const row = n && players[n]; if (row && row.gp > 0 && row.min >= 12 && a.athlete.id) ids.push([n, a.athlete.id]); }
      const logs = await mapLimit(ids, 6, async ([n, id]) => [n, normaliseGamelog(await getJson(GAMELOG_URL(id)), 10)]);
      const good = logs.filter(x => Array.isArray(x) && x[1].length);
      const gl = { fetchedAt: new Date().toISOString(), season: `${Number(season) - 1}-${String(season).slice(2)}`, count: good.length, players: Object.fromEntries(good) };
      writeFileSync(logsOut, JSON.stringify(gl));
      console.log(`wrote ${logsOut}: ${gl.count} players' last-10 game logs (${logs.filter(x => x && x.error).length} failed)`);
    } catch (e) { errors.push('gamelogs: ' + e.message); }
  }
  const payload = { source: args['stats-fixture'] ? 'fixture' : 'ESPN site.web.api.espn.com byathlete (per game) + site.api.espn.com injuries', season: `${Number(season) - 1}-${String(season).slice(2)}`, fetchedAt: new Date().toISOString(), count: Object.keys(players).length, injuryCount: Object.keys(injuries).length, statsNote, errors, players, injuries };
  if (!payload.count && !payload.injuryCount) throw new Error('nothing usable fetched (no current-season stats, no injuries); not writing');
  mkdirSync('data', { recursive: true });
  writeFileSync(out, JSON.stringify(payload));
  console.log(`wrote ${out}: ${payload.count} players, ${payload.injuryCount} injuries (${payload.source})${statsNote ? ' note: ' + statsNote : ''}${errors.length ? ' errors: ' + errors.join('; ') : ''}`);
}
