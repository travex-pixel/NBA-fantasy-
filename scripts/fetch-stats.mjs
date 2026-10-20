// Fetch live 2026-27 NBA per-game stats and write data/live-stats.json.
// Source: NBA Stats API (stats.nba.com, free, no key). Needs the environment to allow stats.nba.com.
// Usage: node scripts/fetch-stats.mjs [--season 2026-27] [--fixture path.json] [--out data/live-stats.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const season = args.season || '2026-27';
const out = args.out || 'data/live-stats.json';
const url = `https://stats.nba.com/stats/leaguedashplayerstats?College=&Conference=&Country=&DateFrom=&DateTo=&Division=&DraftPick=&DraftYear=&GameScope=&GameSegment=&Height=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${season}&SeasonSegment=&SeasonType=Regular%20Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=&Weight=`;
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com', 'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' };

async function load() {
  if (args.fixture) return JSON.parse(readFileSync(args.fixture, 'utf8'));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`stats.nba.com ${res.status}`);
  return res.json();
}

/** Normalise the NBA Stats resultSet into {name: perGame}. Exported for tests. */
export function normalise(json) {
  const rs = json?.resultSets?.[0]; if (!rs?.headers || !rs?.rowSet) throw new Error('unexpected payload shape');
  const h = Object.fromEntries(rs.headers.map((k, i) => [k, i]));
  const need = ['PLAYER_NAME', 'TEAM_ABBREVIATION', 'GP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'FG3M', 'FGM', 'FGA', 'FTM', 'FTA', 'TOV'];
  for (const k of need) if (!(k in h)) throw new Error('missing column ' + k);
  const players = {};
  for (const r of rs.rowSet) {
    players[r[h.PLAYER_NAME]] = { team: r[h.TEAM_ABBREVIATION], gp: r[h.GP], min: r[h.MIN], pts: r[h.PTS], reb: r[h.REB], ast: r[h.AST], stl: r[h.STL], blk: r[h.BLK], tpm: r[h.FG3M], fgm: r[h.FGM], fga: r[h.FGA], ftm: r[h.FTM], fta: r[h.FTA], tov: r[h.TOV] };
  }
  return players;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = await load();
  const players = normalise(json);
  const payload = { source: args.fixture ? 'fixture' : 'stats.nba.com leaguedashplayerstats PerGame', season, fetchedAt: new Date().toISOString(), count: Object.keys(players).length, players };
  mkdirSync('data', { recursive: true });
  writeFileSync(out, JSON.stringify(payload));
  console.log(`wrote ${out}: ${payload.count} players (${payload.source})`);
}
