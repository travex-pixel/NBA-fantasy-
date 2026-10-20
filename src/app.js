// UI layer — vanilla JS, mobile-first. All logic lives in engine.js.
import * as E from './engine.js';
import { PLAYERS, DATA_META } from './data.js';
import { SOURCES } from './sources.js';

const STORAGE_KEY = 'draft-war-room-v1';
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = load() || E.createState();
let history = []; // undo stack of previous states
let view = state.mySlot ? 'draft' : 'setup';
let search = '';
let timerEnd = null; let timerHandle = null;
let pendingAmbiguous = null; // { names: [], index, candidates }
let playersFilter = 'avail';
let detailId = null;
// --- Screenshot quick pick (uses the artifact runtime's `sample` capability; absent elsewhere) ---
let shot = { status: 'idle' }; // idle | reading | ready | error ; ready: { parsed, proposals, conflicts, unmatched, ambiguous, rec, pickNote }
let vision = { checked: false, sample: null, images: false };
// --- Live NBA stats (written by scripts/fetch-stats.mjs; hosted page reads the artifact db doc stats/latest,
//     other copies read ./data/live-stats.json). Nothing is shown unless a real payload loads. ---
let liveData = null; let liveStatus = 'not loaded';
async function loadLiveStats() {
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      const db = await window.claude.use('db');
      if (db) {
        const snap = await db.doc('stats/latest').get();
        if (snap.exists) { liveData = snap.data(); liveStatus = 'artifact db'; render(); return; }
        liveStatus = 'no stats document yet'; render(); return;
      }
    }
    if (location.protocol !== 'file:') {
      const res = await fetch('./data/live-stats.json', { cache: 'no-store' });
      if (res.ok) { const j = await res.json(); if (j && j.players) { liveData = j; liveStatus = 'data/live-stats.json'; render(); return; } }
      liveStatus = 'data/live-stats.json not found';
    } else liveStatus = 'unavailable from a local file';
  } catch (e) { liveStatus = 'failed to load (' + (e?.code || e?.message || 'error') + ')'; }
  render();
}
async function detectVision() {
  try {
    if (!window.claude || typeof window.claude.use !== 'function') { vision = { checked: true, sample: null, images: false }; return; }
    const sample = await window.claude.use('sample');
    const limits = sample ? await sample.limits().catch(() => null) : null;
    vision = { checked: true, sample, images: !!(limits && limits.images), accept: limits?.images?.mediaTypes?.join(',') || 'image/*' };
  } catch { vision = { checked: true, sample: null, images: false }; }
  render();
}
let dialog = null; // in-page replacement for the browser dialogs the artifact viewer blocks: { text, input?, value?, buttons: [{label, primary, onClick(value)}] }
function ask(d) { dialog = d; render(); }
function notify(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(notify._t); notify._t = setTimeout(() => el.classList.remove('show'), 4500);
}

function load() { try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); return s && s.picks ? s : null; } catch { return null; } }
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }
function setState(next, { undoable = true } = {}) { if (undoable) history.push(state); if (history.length > 50) history.shift(); state = next; save(); render(); }

function valued() {
  const weights = {}; for (const k of state.punts || []) weights[k] = 0;
  const base = liveData?.players ? E.applyLiveStats(PLAYERS, liveData.players, { use: state.useLive !== false, k: 25, injuries: liveData.injuries || {} }).players : PLAYERS;
  return E.computeValues(base, { gpWeight: state.gpWeight !== false, weights });
}
function injuryBadge(p) {
  if (!p.injury) return '';
  const st = String(p.injury.status || '').toLowerCase(); const cls = /out/.test(st) && !/doubt/.test(st) ? 'inj-out' : /doubt/.test(st) ? 'inj-out' : 'inj-gtd';
  return `<span class="inj ${cls}" title="${esc(p.injury.comment || '')}">${esc(p.injury.status || 'INJ')}${p.injury.returnDate ? ' → ' + esc(p.injury.returnDate) : ''}</span>`;
}
function liveLine(p) {
  if (!p.live) return '';
  const l = p.live; const fg = l.fga ? (100 * l.fgm / l.fga).toFixed(1) : '-'; const ft = l.fta ? (100 * l.ftm / l.fta).toFixed(1) : '-';
  return `Live 26-27 (${l.gp} gp, ${l.min} min): ${l.pts} pts · ${l.reb} reb · ${l.ast} ast · ${l.stl} st · ${l.blk} blk · ${l.tpm} 3pm · FG ${fg}% · FT ${ft}% · ${l.tov} to`;
}

function ctx() {
  const all = valued();
  const byId = Object.fromEntries(all.map(p => [p.id, p]));
  const overall = E.currentOverall(state);
  const onClock = E.teamOnClock(Math.min(overall, state.numTeams * E.ROSTER_SIZE), state.numTeams);
  const myNext = state.mySlot ? E.nextPickForSlot(state.mySlot, state.numTeams, overall) : null;
  const myFollowing = state.mySlot ? E.followingPickForSlot(state.mySlot, state.numTeams, myNext ?? overall) : null;
  const roster = E.myRoster(state, all);
  const avail = E.availablePlayers(state, all);
  const rec = E.recommend(avail, roster, { punts: state.punts, currentPick: myNext ?? overall, nextPick: myFollowing ?? (myNext ?? overall) + state.numTeams, });
  return { all, byId, overall, onClock, myNext, myFollowing, roster, avail, rec, done: overall > state.numTeams * E.ROSTER_SIZE };
}

// ---------- rendering ----------
function render() {
  const root = $('#app');
  const c = ctx();
  root.innerHTML = `
    ${view !== 'setup' ? header(c) : ''}
    <main class="main">${view === 'setup' ? setupView(c) : view === 'draft' ? draftView(c) : view === 'players' ? playersView(c) : strategyView(c)}</main>
    ${view !== 'setup' ? nav() : ''}
    ${detailId ? detailModal(c) : ''}
    ${pendingAmbiguous ? ambiguousModal() : ''}
    ${dialog ? dialogModal() : ''}
  `;
  bind(c);
}

function header(c) {
  const mine = state.mySlot && c.onClock === state.mySlot && !c.done;
  const t = timerEnd ? Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000)) : null;
  return `<header class="hdr ${mine ? 'mine' : ''}">
    <div class="hdr-row">
      <div><div class="hdr-k">Pick</div><div class="hdr-v">${c.done ? 'Done' : `${c.overall} <span class="muted">(R${E.roundOf(c.overall, state.numTeams)}.${E.pickInRound(c.overall, state.numTeams)})</span>`}</div></div>
      <div><div class="hdr-k">On clock</div><div class="hdr-v">${c.done ? '—' : mine ? 'YOU' : esc(state.teamNames[c.onClock - 1])}</div></div>
      <div><div class="hdr-k">Your next</div><div class="hdr-v">${c.myNext ? `#${c.myNext}` : '—'}${c.myNext && c.myNext !== c.overall ? ` <span class="muted">(${c.myNext - c.overall} away)</span>` : ''}</div></div>
      <div class="timer ${t != null && t <= 15 ? 'hot' : ''}" id="timer">${t != null ? `${t}s` : '<button class="btn-xs" id="startTimer">60s</button>'}</div>
    </div>
  </header>`;
}

function nav() {
  const b = (id, label) => `<button class="nav-btn ${view === id ? 'on' : ''}" data-view="${id}">${label}</button>`;
  return `<nav class="nav">${b('draft', 'Draft Now')}${b('players', 'Players')}${b('strategy', 'Strategy')}</nav>`;
}

function setupView() {
  const slots = Array.from({ length: state.numTeams }, (_, i) => i + 1);
  return `<section class="card">
    <h1>Draft War Room — Worldwide League</h1>
    <p class="muted">Yahoo league 60156 · 2026-27 · 10 teams · H2H 9-cat · snake · 1-min clock</p>
    <h2>1. League settings (locked to your brief)</h2>
    <ul class="compact">
      <li>Cats: FG%, FT%, 3PM, PTS, REB, AST, ST, BLK, TO (lower is better)</li>
      <li>Roster: PG, SG, G, SF, PF, F, C, C, Util, Util, BN×3, IL×4 → 13 draft rounds</li>
    </ul>
    <h2>2. Your draft slot</h2>
    <div class="slot-grid">${slots.map(s => `<button class="slot-btn ${state.mySlot === s ? 'on' : ''}" data-slot="${s}">${s}</button>`).join('')}</div>
    <p class="muted">Not announced yet? Pick your best guess now — you can change it from Strategy at any time; nothing is lost.</p>
    <h2>3. Team names (optional)</h2>
    <details><summary>Edit team names in draft order</summary>
      ${state.teamNames.map((n, i) => `<label class="row"><span>Slot ${i + 1}</span><input data-team="${i}" value="${esc(n)}" /></label>`).join('')}
    </details>
    <h2>4. Rankings</h2>
    <p>Built-in pool: ${PLAYERS.length} players with analyst 9-cat estimates (checked ${esc(DATA_META.checkedAt)}). Review the plan under Strategy before the draft.</p>
    <button class="btn-primary big" id="startDraft" ${state.mySlot ? '' : 'disabled'}>Open the War Room</button>
  </section>`;
}

function catChips(p, { punts = [] } = {}) {
  return E.CATS.map(c => {
    const z = p.z?.[c.key] ?? 0;
    const cls = punts.includes(c.key) ? 'punt' : z >= 1 ? 'good2' : z >= 0.4 ? 'good' : z <= -1 ? 'bad2' : z <= -0.4 ? 'bad' : '';
    return `<span class="chip ${cls}" title="z=${z.toFixed(2)}">${c.label}</span>`;
  }).join('');
}

function statLine(p) {
  return `${p.live && state.useLive !== false ? 'Blended proj: ' : ''}${p.pts} pts · ${p.reb} reb · ${p.ast} ast · ${p.stl} st · ${p.blk} blk · ${p.tpm} 3pm · FG ${(p.fgp * 100).toFixed(1)}% (${p.fga}) · FT ${(p.ftp * 100).toFixed(1)}% (${p.fta}) · ${p.tov} to · ~${p.gp} gp`;
}

function candCard(cnd, c, { primary = false } = {}) {
  const p = cnd.player;
  return `<div class="cand ${primary ? 'primary' : ''}">
    <div class="cand-top">
      <div>
        <div class="cand-name">${esc(p.name)} <span class="muted">${esc(p.team)} · ${p.positions.join('/')}</span> ${injuryBadge(p)}</div>
        <div class="muted small">Model #${p.modelRank}${typeof p.adp === 'number' ? ` · ADP ~${p.adp}` : ' · ADP n/a'}${cnd.likelyGone === true ? ' · <b>likely gone before your next pick</b>' : cnd.likelyGone === false ? ' · may still be there next pick' : ''}</div>
      </div>
      <div class="cand-actions">
        <button class="btn-primary" data-draft-me="${p.id}">Draft ME</button>
        <button class="btn-ghost" data-draft-other="${p.id}">Taken</button>
      </div>
    </div>
    ${primary ? `
      <ol class="why">${cnd.reasons.map(r => `<li>${esc(r)}</li>`).join('') || '<li>Best remaining 9-cat value for your roster</li>'}</ol>
      <div class="chips">${catChips(p, { punts: state.punts })}</div>
      ${cnd.weaknesses.length ? `<div class="small">Weak: ${cnd.weaknesses.join(', ')}</div>` : ''}
      <div class="small">Roster fit: ${fitText(cnd, c)}</div>
      ${cnd.flags.length ? `<div class="flag">⚠ ${cnd.flags.map(esc).join(' · ')}</div>` : '<div class="small ok">No major risk flag</div>'}
      ${cnd.adpNote ? `<div class="small">${esc(cnd.adpNote)}</div>` : '<div class="small muted">ADP: no reliable number for this player</div>'}
      <details class="small"><summary>Details</summary><div>${esc(statLine(p))}</div>${p.live ? `<div class="live">${esc(liveLine(p))}</div>` : ''}${p.note ? `<div>${esc(p.note)}</div>` : ''}<div class="muted">Score ${cnd.score.toFixed(2)} (9-cat z ${cnd.baseZ.toFixed(2)})</div></details>
    ` : `<div class="chips">${catChips(p, { punts: state.punts })}</div>${cnd.flags.length ? `<div class="flag small">⚠ ${cnd.flags.map(esc).join(' · ')}</div>` : ''}`}
  </div>`;
}

function fitText(cnd, c) {
  const open = c.rec.open;
  if (!open.length) return 'roster full';
  const fits = open.filter(s => E.canFillSlot(s, cnd.player.positions));
  return fits.length ? `fills ${[...new Set(fits)].join('/')} (open: ${open.join(', ')})` : `no open slot (open: ${open.join(', ')})`;
}

function draftView(c) {
  if (c.done) return `<section class="card"><h2>Draft complete</h2>${rosterPanel(c)}</section>`;
  const mine = state.mySlot && c.onClock === state.mySlot;
  const rec = c.rec;
  const until = c.myNext && c.myNext > c.overall ? c.myNext - c.overall : 0;
  return `
    ${quickPickCard(c)}
    <section class="card quick">
      <form id="takenForm" class="taken-form">
        <input id="takenInput" placeholder="TAKEN: name, name, name  (or one name)" autocomplete="off" />
        <button class="btn-primary" type="submit">Mark taken</button>
      </form>
      <div class="row-btns">
        <button class="btn-ghost" id="undo" ${state.picks.length ? '' : 'disabled'}>↶ Undo last pick</button>
        <span class="muted small">${state.picks.length} picks logged</span>
      </div>
    </section>
    <section class="card ${mine ? 'mine-card' : ''}">
      <div class="label">${mine ? 'YOUR PICK — BEST PICK NOW' : `BEST PICK IF IT WERE YOUR TURN (${until} pick${until === 1 ? '' : 's'} until #${c.myNext ?? '—'})`}</div>
      ${rec.best ? candCard(rec.best, c, { primary: true }) : '<p>No players available.</p>'}
      <div class="conf conf-${rec.confidence}">Confidence: <b>${rec.confidence.toUpperCase()}</b> — ${esc(rec.confidenceWhy)}</div>
      <div class="label">BACKUPS</div>
      ${rec.backups.map(b => candCard(b, c)).join('')}
      ${!mine && until > 0 ? `<details class="small"><summary>Targets likely to survive ${until} picks</summary>${rec.candidates.slice(0, 12).filter(x => x.likelyGone === false).slice(0, 5).map(x => `<div>${esc(x.player.name)} (ADP ~${x.player.adp})</div>`).join('') || '<div class="muted">Nobody in the top 12 has an ADP late enough to count on.</div>'}</details>` : ''}
    </section>
    <section class="card">${rosterPanel(c)}</section>
    <section class="card"><details><summary>Draft ledger (${state.picks.length})</summary>${ledger(c)}</details></section>`;
}

function quickPickCard(c) {
  const canRead = vision.checked && vision.sample && vision.images;
  let body = '';
  if (!vision.checked) body = '<div class="small muted">Checking whether screenshot reading is available in this view…</div>';
  else if (!canRead) body = `<div class="small flag">Screenshot reading is not available in this copy of the app${vision.sample ? ' (images not permitted here)' : ''}. Fallback: send the screenshot to Claude in the chat and paste the names into the TAKEN box below, or tap Taken in the Players tab.</div>`;
  else body = `<button class="btn-primary big file-btn" id="shotBtn" type="button">📷 QUICK PICK FROM SCREENSHOT</button>
    <div class="small muted" style="margin-top:6px">If the button does nothing: copy the screenshot (Photos → Share → Copy, or tap it in the keyboard's clipboard bar), then long-press the box below and Paste.</div>
    <div id="pasteBox" class="paste-box" contenteditable="true" inputmode="none" aria-label="Paste screenshot here">Long-press here → Paste screenshot</div>
    <input type="file" id="shotInput" accept="${esc(vision.accept)}" class="file-input" />
    <div class="small muted">Yahoo draft room screenshot (Players list, Draft Results or My Team). Claude reads it; nothing is logged until you confirm.</div>`;
  if (vision.checked) body = `<div class="small muted">Status: ${canRead ? 'screenshot reading ready' : vision.sample ? 'Claude reachable but images not permitted' : 'no Claude runtime in this view'}</div>` + body;
  if (shot.status === 'reading') body += `<div class="reading">Reading screenshot… <button class="btn-xs" id="shotCancel">Stop</button></div>`;
  if (shot.status === 'error') body += `<div class="flag">${esc(shot.msg)}</div>`;
  if (shot.status === 'ready') body += quickPickResult(c);
  return `<section class="card qp">${body}</section>`;
}

function quickPickResult(c) {
  const r = shot;
  const line = (label, cnd, seen) => cnd ? `<div class="qp-row"><span class="qp-label">${label}</span><span class="qp-name">${esc(cnd.player.name)} <span class="muted small">${esc(cnd.player.team)} ${cnd.player.positions.join('/')}${seen[cnd.player.id] === 'available' ? ' · seen available' : seen[cnd.player.id] ? '' : ' · not visible in shot, verify'}</span></span><button class="btn-primary btn-sm" data-qp-draft="${cnd.player.id}">I drafted</button></div>` : '';
  const seen = r.seen || {};
  const best = r.rec.best;
  const risk = best ? best.flags.filter(f => !/^Only a flex|^No open slot/.test(f)) : [];
  const n = r.proposals.filter(p => p.on).length;
  return `
    <div class="qp-out">
      ${line('BEST PICK NOW', best, seen)}
      ${line('BACKUP 1', r.rec.backups[0], seen)}
      ${line('BACKUP 2', r.rec.backups[1], seen)}
      ${best ? `<div class="small"><b>WHY:</b> ${esc(whySentence(best, c))}</div>` : '<div class="flag">No available player found.</div>'}
      ${risk.length ? `<div class="small flag"><b>RISK:</b> ${esc(risk.join('; '))}</div>` : ''}
      ${r.pickNote ? `<div class="small flag">${esc(r.pickNote)}</div>` : ''}
      ${r.parsed.partial ? '<div class="small muted">Screenshot shows only part of the pool; recommendation uses the full remaining pool.</div>' : ''}
      ${r.parsed.uncertain?.length ? `<div class="small muted">Uncertain in image: ${esc(r.parsed.uncertain.join('; '))}</div>` : ''}
    </div>
    ${r.proposals.length ? `<div class="label">UPDATES FROM SCREENSHOT — confirm before they apply</div>
      ${r.proposals.map((p, i) => `<label class="qp-prop"><input type="checkbox" data-prop="${i}" ${p.on ? 'checked' : ''}/> <span>${p.type === 'mine' ? 'My roster: ' : 'Taken: '}${esc(p.player.name)}${p.pick ? ` (#${p.pick})` : ''}</span></label>`).join('')}
      <button class="btn-ghost" id="qpApply">Apply ${n} update${n === 1 ? '' : 's'} (no draft)</button>` : '<div class="small muted">No new picks found in the screenshot.</div>'}
    ${r.conflicts.length ? `<div class="flag small">Conflicts: ${r.conflicts.map(esc).join(' · ')}</div>` : ''}
    ${r.dupes ? `<div class="small muted">${r.dupes} already logged, skipped.</div>` : ''}
    ${r.ambiguous.length ? `<div class="flag small">Ambiguous names — tap the right player to add as Taken: ${r.ambiguous.map(a => `<div>${esc(a.input)}: ${a.candidates.map(p => `<button class="btn-xs" data-amb-add="${p.id}">${esc(p.name)}</button>`).join(' ')}</div>`).join('')}</div>` : ''}
    ${r.unmatched.length ? `<div class="small muted">Not in pool: ${r.unmatched.map(esc).join(', ')} (log via Players tab if needed)</div>` : ''}
    <div class="row-btns"><button class="btn-xs" id="qpReread">Re-read carefully (slower)</button><button class="btn-xs" id="qpClear">Dismiss</button></div>`;
}

function whySentence(cnd, c) {
  const s = cnd.strengths.length ? `${cnd.strengths.slice(0, 3).join('/')} ` : 'balanced 9-cat value ';
  const fit = c.rec.open.length ? fitText(cnd, c).split(' (')[0] : 'roster full';
  const need = cnd.reasons.find(r => r.startsWith('Shores up'));
  return `${s}from a ${cnd.player.positions.join('/')} that ${fit}${need ? '; ' + need.toLowerCase() : ''}.`;
}

const SHOT_PROMPT = (poolNames) => `You are reading a screenshot of a Yahoo Fantasy Basketball LIVE DRAFT room (2026-27 season) taken on an Android phone. Extract only what is legibly visible. Never invent names, picks or statuses.
Reply with ONLY one JSON object:
{"screen":"available_players|draft_results|my_team|mixed|unclear","round":null,"pick":null,"players":[{"name":"First Last","status":"available|drafted|mine|unknown","pick":null,"team":null}],"partial":true,"uncertain":[],"notes":""}
Rules:
- "status": "drafted" only for players shown as taken (a Draft Results / picks list, a drafted/strikethrough mark, or a team roster); "mine" only for players under MY team's roster; "available" only for rows in the available Players list with no drafted mark; otherwise "unknown".
- "pick": the overall pick number if shown next to a drafted player, else null. "team": the drafting team name if shown.
- "round"/"pick" at the top level: the current round and overall pick shown in the header, if visible, else null.
- "partial": true if the list is scrolled or cut off so other players certainly exist that are not visible.
- "uncertain": short notes for any name you could not read confidently (put that name's status as "unknown").
- Use the exact spelling from this known pool when the screenshot clearly matches one of them: ${poolNames}`;

async function readScreenshot(file, { careful = false } = {}) {
  if (!file) return;
  const sample = vision.sample;
  if (!sample) { shot = { status: 'error', msg: 'Screenshot reading is not available in this view.' }; render(); return; }
  const ctl = new AbortController(); shot = { status: 'reading', ctl, file }; render();
  const c = ctx();
  try {
    const parsed = await sample.json(SHOT_PROMPT(c.all.map(p => p.name).join(', ')), { images: [file], modelTier: careful ? 'default' : 'quick', cache: false, signal: ctl.signal });
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.players)) throw { code: 'invalid_json', message: 'no players array' };
    shot = analyseShot(parsed, c);
  } catch (e) {
    if (e && e.code === 'cancelled') { shot = { status: 'idle' }; render(); return; }
    const copy = { not_granted: 'You declined Claude access for this page, so screenshots cannot be read. Use the TAKEN box instead.', images_unavailable: 'This view cannot send images to Claude. Use the TAKEN box instead.', image_rejected: 'That image was rejected (type/size). Try a plain PNG/JPEG screenshot.', rate_limited: 'Claude is rate-limited right now. Wait a moment or use the TAKEN box.', invalid_json: 'Claude could not produce a readable list from that image. Try a clearer or tighter screenshot, or paste names.', refused: 'Claude declined to read that image.', session_expired: 'Your Claude session expired. Sign in again.' };
    shot = { status: 'error', msg: copy[e?.code] || `Could not read the screenshot (${e?.code || e?.message || 'unknown error'}). Use the TAKEN box instead.` };
  }
  render();
}

/** Pure-ish: turn parsed screenshot JSON into proposals/conflicts and a tentative recommendation. Exported for tests via window. */
function analyseShot(parsed, c) {
  const drafted = E.draftedIds(state);
  const mineIds = new Set(c.roster.map(p => p.id));
  const proposals = [], conflicts = [], unmatched = [], ambiguous = [], seen = {}; let dupes = 0;
  const seenIds = new Set();
  for (const row of parsed.players || []) {
    const name = String(row?.name || '').trim(); if (!name) continue;
    const status = ['available', 'drafted', 'mine', 'unknown'].includes(row.status) ? row.status : 'unknown';
    const r = E.resolveName(name, c.all);
    if (r.ambiguous) { if (status !== 'available') ambiguous.push({ input: name, candidates: r.ambiguous }); continue; }
    if (!r.match) { if (status !== 'available') unmatched.push(name); continue; }
    const p = r.match; if (seenIds.has(p.id)) continue; seenIds.add(p.id);
    seen[p.id] = status;
    const pick = Number.isInteger(row.pick) ? row.pick : null;
    if (status === 'drafted') {
      if (mineIds.has(p.id)) continue;
      if (drafted.has(p.id)) { dupes++; continue; }
      proposals.push({ type: 'taken', player: p, pick, on: true });
    } else if (status === 'mine') {
      if (mineIds.has(p.id)) { dupes++; continue; }
      if (drafted.has(p.id)) { conflicts.push(`${p.name} is on your team in the screenshot but logged as taken by another team (#${state.picks.find(x => x.playerId === p.id)?.overall})`); continue; }
      proposals.push({ type: 'mine', player: p, pick, on: true });
    } else if (status === 'available' && drafted.has(p.id)) {
      conflicts.push(`${p.name} looks available in the screenshot but is logged as drafted (#${state.picks.find(x => x.playerId === p.id)?.overall}) — undo if wrong`);
    }
  }
  proposals.sort((a, b) => (a.pick ?? 1e9) - (b.pick ?? 1e9));
  const rec = tentativeRec(proposals, c);
  // pick-number sanity
  let pickNote = null;
  const shotPick = Number.isInteger(parsed.pick) ? (Number.isInteger(parsed.round) && parsed.pick <= state.numTeams ? (parsed.round - 1) * state.numTeams + parsed.pick : parsed.pick) : null;
  if (shotPick) {
    const after = c.overall + proposals.length;
    if (shotPick !== after) pickNote = `Screenshot header says pick #${shotPick}; the app will be at #${after} after these updates. ${shotPick > after ? `${shotPick - after} pick(s) are missing — log them with TAKEN.` : 'Check for a duplicate entry (Undo).'}`;
  }
  return { status: 'ready', parsed, proposals, conflicts, unmatched, ambiguous, dupes, seen, rec, pickNote };
}

function tentativeRec(proposals, c) {
  const on = proposals.filter(p => p.on);
  const gone = new Set(on.map(p => p.player.id));
  const roster = [...c.roster, ...on.filter(p => p.type === 'mine').map(p => p.player)];
  const avail = c.avail.filter(p => !gone.has(p.id));
  const overall = c.overall + on.length;
  const myNext = state.mySlot ? E.nextPickForSlot(state.mySlot, state.numTeams, overall) : overall;
  const myFollowing = state.mySlot ? E.followingPickForSlot(state.mySlot, state.numTeams, myNext ?? overall) : overall + state.numTeams;
  return E.recommend(avail, roster, { punts: state.punts, currentPick: myNext ?? overall, nextPick: myFollowing ?? overall + state.numTeams });
}

function applyShot({ draftId = null } = {}) {
  if (shot.status !== 'ready') return;
  history.push(state);
  let next = state; const errs = [];
  for (const p of shot.proposals.filter(p => p.on)) {
    try { next = E.draftPlayer(next, p.player.id, p.type === 'mine' ? { slot: state.mySlot } : {}); } catch (e) { errs.push(`${p.player.name}: ${e.message}`); }
  }
  if (draftId) {
    try { next = E.draftPlayer(next, draftId, { slot: state.mySlot }); } catch (e) { errs.push(e.message); }
  }
  state = next; save();
  shot = { status: 'idle' };
  render();
  if (errs.length) notify('Skipped: ' + errs.join(' · ')); else notify(draftId ? 'Pick logged. Undo if wrong.' : 'Updates applied. Undo if wrong.');
}

function rosterPanel(c) {
  const a = E.assignRoster(c.roster);
  const prof = c.rec.profile;
  return `<div class="label">YOUR ROSTER (${c.roster.length}/${E.ROSTER_SIZE})</div>
    <div class="roster">${a.assignments.map(x => `<div class="rslot ${x.player ? 'filled' : ''}"><span class="rs">${x.slot}</span><span>${x.player ? esc(x.player.name) + ' ' + injuryBadge(x.player) : '<span class="muted">open</span>'}</span></div>`).join('')}</div>
    <div class="label">CATEGORY BALANCE (sum of z)</div>
    <div class="bars">${E.CATS.map(k => { const v = prof[k.key] || 0; const w = Math.min(100, Math.abs(v) / 6 * 100); return `<div class="bar"><span class="bl">${k.label}</span><div class="bt"><div class="bf ${v >= 0 ? 'pos' : 'neg'} ${state.punts.includes(k.key) ? 'punt' : ''}" style="width:${w}%"></div></div><span class="bv">${v >= 0 ? '+' : ''}${v.toFixed(1)}</span></div>`; }).join('')}</div>`;
}

function ledger(c) {
  if (!state.picks.length) return '<p class="muted">No picks yet.</p>';
  return `<div class="ledger">${[...state.picks].reverse().map(p => `<div><b>#${p.overall}</b> ${esc(state.teamNames[p.slot - 1])}${p.slot === state.mySlot ? ' (you)' : ''}: ${esc(c.byId[p.playerId]?.name || p.playerId)}</div>`).join('')}</div>`;
}

function playersView(c) {
  const q = E.normaliseName(search);
  let list = playersFilter === 'avail' ? c.avail : playersFilter === 'drafted' ? c.all.filter(p => E.draftedIds(state).has(p.id)) : c.all;
  if (q) list = list.filter(p => E.normaliseName(p.name).includes(q) || p.team.toLowerCase() === q || p.positions.some(x => x.toLowerCase() === q));
  const gone = E.draftedIds(state);
  return `<section class="card sticky-search">
    <input id="search" placeholder="Search name / team / position" value="${esc(search)}" autocomplete="off" />
    <div class="row-btns">
      ${['avail', 'all', 'drafted'].map(f => `<button class="btn-xs ${playersFilter === f ? 'on' : ''}" data-filter="${f}">${f === 'avail' ? 'Available' : f === 'all' ? 'All' : 'Drafted'}</button>`).join('')}
      <span class="muted small">${list.length} shown · sorted by model value</span>
    </div>
  </section>
  <section class="list">${list.slice(0, 150).map(p => `<div class="prow ${gone.has(p.id) ? 'gone' : ''}">
      <div class="pinfo" data-detail="${p.id}"><div><b>${p.modelRank}.</b> ${esc(p.name)} <span class="muted">${esc(p.team)} ${p.positions.join('/')}</span> ${injuryBadge(p)}</div>
      <div class="small muted">${typeof p.adp === 'number' ? `ADP ~${p.adp}` : 'ADP n/a'}${p.risk ? ' · ⚠' : ''} · ${p.value.toFixed(1)}${p.live ? ` · <span class="live">live ${p.live.gp} gp: ${p.live.pts}/${p.live.reb}/${p.live.ast}</span>` : ''}</div></div>
      ${gone.has(p.id) ? '<span class="muted small">drafted</span>' : `<div class="cand-actions"><button class="btn-primary btn-sm" data-draft-me="${p.id}">ME</button><button class="btn-ghost btn-sm" data-draft-other="${p.id}">Taken</button></div>`}
    </div>`).join('') || '<p class="muted card">No match. Player not in the pool? Draft the pick as "Unknown" below.</p>'}
    <div class="card"><button class="btn-ghost" id="unknownOther">Log a pick by another team for a player not in this list</button></div>
  </section>`;
}

function strategyView(c) {
  const slot = state.mySlot;
  const picks = slot ? E.picksForSlot(slot, state.numTeams) : [];
  const top = c.all.slice(0, 40);
  const punts = state.punts;
  const puntBtn = k => `<button class="btn-xs ${punts.includes(k.key) ? 'on' : ''}" data-punt="${k.key}">${k.label}</button>`;
  return `<section class="card">
    <h2>Settings</h2>
    <label class="row"><span>My draft slot</span><select id="slotSel">${Array.from({ length: state.numTeams }, (_, i) => `<option value="${i + 1}" ${slot === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
    <div class="small muted">Your picks: ${picks.join(', ')}</div>
    <label class="row"><span>Weight by games played</span><input type="checkbox" id="gpw" ${state.gpWeight !== false ? 'checked' : ''}/></label>
    <div class="row"><span>Punt (set weight to 0)</span><div class="chips">${E.CATS.map(puntBtn).join('')}</div></div>
    <div class="small muted">Punting is a tool, not a default. Only turn one on if your first 3-4 picks naturally point there (e.g. Giannis + Gobert/Kessler → punt FT%).</div>
    <button class="btn-ghost danger" id="reset">Reset draft (clear all picks)</button>
  </section>
  <section class="card">
    <h2>Live NBA stats</h2>
    ${liveData ? `<div class="small">Source: ${esc(liveData.source)} · season ${esc(liveData.season)} · fetched ${esc(liveData.fetchedAt)} · ${liveData.count} players · matched to pool: ${E.applyLiveStats(PLAYERS, liveData.players).matched}${liveData.injuries ? ` · injuries listed: ${Object.keys(liveData.injuries).length}` : ' · no injury report in payload'}</div>` : `<div class="small flag">No live stats loaded (${esc(liveStatus)}). Run <code>node scripts/fetch-stats.mjs</code> and publish the result; see README.</div>`}
    <label class="row"><span>Blend live stats into projections (K = 25 games)</span><input type="checkbox" id="useLive" ${state.useLive !== false ? 'checked' : ''}/></label>
    <div class="small muted">Blended = (preseason × 25 + live × games) ÷ (25 + games). Percentages blend on makes and attempts. Unmatched players keep their preseason line.</div>
  </section>
  <section class="card">
    <h2>Draft plan — 10-team 9-cat H2H</h2>
    <ol class="plan">
      <li><b>Rounds 1-2: take elite efficiency + stocks.</b> Jokic/Wembanyama/SGA are a tier of their own; after that prefer players who are positive in 6+ cats (Maxey, Cunningham, Tatum, J. Johnson, Mobley, Holmgren, Durant, Curry, Haliburton-if-you-accept-risk). Low-TO guards with FT% (SGA, Maxey, Murray, Curry) and bigs with FG%/BLK (Chet, Mobley, Kessler) travel well in every build.</li>
      <li><b>Rounds 3-6: lock both C slots early enough.</b> Two dedicated C slots in a 10-teamer dry up fast (Zubac, Sengun, Bam, Duren, Turner, Allen, Kessler, Gobert). Don't leave round 7 without one C.</li>
      <li><b>Balanced by default.</b> Only punt FT% (Giannis/Gobert/Duren/Kessler/Clingan core) or punt 3PM (Amen, Ausar, Murray-Boyles) if the draft falls that way. Punt-TO/Luka is tempting but costs a real category every week; only with a strong ST/BLK core.</li>
      <li><b>Rounds 7-10: category specialists.</b> Steals (Dyson Daniels, Ausar, Wallace, Herb Jones, Camara), blocks (Clingan, Turner, Queta, Ware), low-TO 3PM (Pritchard, Nesmith, Keegan Murray).</li>
      <li><b>Rounds 11-13: upside/availability.</b> Coward, Ty Jerome, Suggs, Day'Ron Sharpe, Maluach, Murray-Boyles, Buzelis-if-left; avoid stashing more than one long-term injury (Butler/Porzingis) — you have 4 IL slots but only 3 BN.</li>
      <li><b>Avoid at price:</b> Embiid (consensus avoid), LeBron and Jaylen Brown at their Yahoo ADP (usage split in PHI), Morant (crowded POR, availability), Kawhi before round 4, LaMelo before round 4, Poeltl.</li>
    </ol>
    <h2>Position-specific notes</h2>
    <ul class="plan">
      <li><b>Picks 1-3:</b> Jokic → Wembanyama → SGA. No thinking required.</li>
      <li><b>Picks 4-6:</b> Luka (accept TO/FG% drag) vs Maxey/Cade/Tatum/Edwards. In 9-cat, Maxey or Tatum is the safer balanced pick; Luka if you'll punt TO.</li>
      <li><b>Picks 7-10:</b> Whoever is left of Maxey/Cade/Edwards/Tatum/J. Johnson/Flagg, then the Durant/Chet/Mobley/Curry tier comes back to you at 11-14.</li>
    </ul>
  </section>
  <section class="card">
    <h2>Model board (top 40)</h2>
    <div class="small muted">Analyst estimates — see sources below. Green = strength, red = weakness.</div>
    ${top.map(p => `<div class="prow"><div class="pinfo" data-detail="${p.id}"><div><b>${p.modelRank}.</b> ${esc(p.name)} <span class="muted">${esc(p.team)} ${p.positions.join('/')}${typeof p.adp === 'number' ? ` · ADP ~${p.adp}` : ''}</span></div><div class="chips">${catChips(p, { punts })}</div></div></div>`).join('')}
  </section>
  <section class="card">
    <h2>Data & sources (checked ${esc(DATA_META.checkedAt)})</h2>
    <p class="small">${esc(DATA_META.method)}</p>
    <p class="small flag">${esc(DATA_META.limitation)}</p>
    <ul class="small src">${SOURCES.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> — ${esc(s.status)}</li>`).join('')}</ul>
    <p class="small">Yahoo integration: <b>not connected</b>. Yahoo's API needs a registered OAuth app and signed agreement; this is manual mode.</p>
  </section>`;
}

function detailModal(c) {
  const p = c.byId[detailId]; if (!p) return '';
  return `<div class="modal" id="modal"><div class="modal-card">
    <h2>${esc(p.name)} <span class="muted">${esc(p.team)} · ${p.positions.join('/')}</span> ${injuryBadge(p)}</h2>
    ${p.injury ? `<p class="small flag">${esc(p.injury.status || '')}${p.injury.type ? ' · ' + esc(p.injury.type) : ''}${p.injury.detail ? ' · ' + esc(p.injury.detail) : ''}${p.injury.returnDate ? ' · est. return ' + esc(p.injury.returnDate) : ''}${p.injury.comment ? '<br>' + esc(p.injury.comment) : ''}</p>` : ''}
    <div class="chips">${catChips(p, { punts: state.punts })}</div>
    <p class="small">${esc(statLine(p))}</p>
    ${p.live ? `<p class="small live">${esc(liveLine(p))}</p>` : ''}
    <p class="small">Model rank #${p.modelRank} · value ${p.value.toFixed(2)} · ${typeof p.adp === 'number' ? `ADP ~${p.adp}` : 'ADP n/a'}</p>
    ${p.risk ? `<p class="flag">⚠ ${esc(p.risk)}</p>` : ''}${p.note ? `<p class="small">${esc(p.note)}</p>` : ''}
    <div class="row-btns">${E.draftedIds(state).has(p.id) ? '' : `<button class="btn-primary" data-draft-me="${p.id}">Draft ME</button><button class="btn-ghost" data-draft-other="${p.id}">Taken</button>`}<button class="btn-ghost" data-remove="${p.id}">Not in pool</button><button class="btn-ghost" id="closeModal">Close</button></div>
  </div></div>`;
}

function dialogModal() {
  const d = dialog;
  return `<div class="modal"><div class="modal-card">
    <p>${esc(d.text)}</p>
    ${d.input ? `<input id="dlgInput" ${d.input === 'number' ? 'type="number" inputmode="numeric"' : ''} value="${esc(d.value ?? '')}" placeholder="${esc(d.placeholder ?? '')}" />` : ''}
    <div class="row-btns">${d.buttons.map((b, i) => `<button class="${b.primary ? 'btn-primary' : 'btn-ghost'}" data-dlg="${i}">${esc(b.label)}</button>`).join('')}</div>
  </div></div>`;
}

function ambiguousModal() {
  const a = pendingAmbiguous;
  return `<div class="modal"><div class="modal-card">
    <h2>Which player?</h2><p>"${esc(a.input)}" matches several players. Tap the right one.</p>
    ${a.candidates.map(p => `<button class="btn-ghost block" data-pick-amb="${p.id}">${esc(p.name)} <span class="muted">${esc(p.team)} ${p.positions.join('/')}</span></button>`).join('')}
    <button class="btn-ghost block" id="skipAmb">Skip this name</button>
  </div></div>`;
}

// ---------- actions ----------
function draft(id, forMe) {
  const c = ctx();
  const onClock = c.onClock;
  const commit = (slot) => { try { const next = E.draftPlayer(state, id, slot ? { slot } : {}); detailId = null; dialog = null; setState(next); } catch (e) { notify(e.message); } };
  if (forMe) {
    if (!state.mySlot) { notify('Set your draft slot first (Strategy tab).'); return; }
    if (onClock !== state.mySlot) {
      ask({ text: `It's slot ${onClock}'s pick (${state.teamNames[onClock - 1]}), not yours. Log this player to YOUR roster anyway? Pick numbers may drift until you log the missing picks.`,
        buttons: [{ label: 'Log to my roster', primary: true, onClick: () => commit(state.mySlot) }, { label: 'Cancel' }] });
      return;
    }
    commit();
  } else if (onClock === state.mySlot) {
    ask({ text: `It's YOUR pick (#${E.currentOverall(state)}). Which slot actually took this player? (1-${state.numTeams})`, input: 'number', value: onClock,
      buttons: [{ label: 'Mark taken', primary: true, onClick: v => { const n = parseInt(v, 10); commit(Number.isInteger(n) && n >= 1 && n <= state.numTeams ? n : onClock); } }, { label: 'Cancel' }] });
  } else commit(onClock);
}

function processTaken(text) {
  const names = E.parseNameList(text);
  if (!names.length) return;
  pendingAmbiguous = null;
  runTakenQueue(names, 0);
}
function runTakenQueue(names, i) {
  const c = ctx();
  const failures = [];
  for (; i < names.length; i++) {
    const r = E.resolveName(names[i], c.avail);
    if (r.match) { try { state = E.draftPlayer(state, r.match.id); } catch (e) { failures.push(`${names[i]}: ${e.message}`); } continue; }
    if (r.ambiguous) { pendingAmbiguous = { input: names[i], candidates: r.ambiguous, names, index: i }; history.push(state); save(); render(); return; }
    // none: maybe already drafted?
    const all = E.resolveName(names[i], c.all);
    failures.push(all.match ? `${names[i]}: already drafted` : `${names[i]}: not found (use Players tab / "Not in pool")`);
  }
  history.push(state); save(); render();
  if (failures.length) notify('Could not process: ' + failures.join(' · '));
}

function bind(c) {
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
  document.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => setState({ ...state, mySlot: +b.dataset.slot }, { undoable: false }));
  document.querySelectorAll('[data-team]').forEach(i => i.onchange = () => { const t = [...state.teamNames]; t[+i.dataset.team] = i.value || `Team ${+i.dataset.team + 1}`; state = { ...state, teamNames: t }; save(); });
  const sd = $('#startDraft'); if (sd) sd.onclick = () => { view = 'draft'; render(); };
  document.querySelectorAll('[data-draft-me]').forEach(b => b.onclick = () => draft(b.dataset.draftMe, true));
  document.querySelectorAll('[data-draft-other]').forEach(b => b.onclick = () => draft(b.dataset.draftOther, false));
  document.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => { detailId = b.dataset.detail; render(); });
  document.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { detailId = null; setState({ ...state, removed: [...(state.removed || []), b.dataset.remove] }); });
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { playersFilter = b.dataset.filter; render(); });
  document.querySelectorAll('[data-punt]').forEach(b => b.onclick = () => { const k = b.dataset.punt; const p = state.punts.includes(k) ? state.punts.filter(x => x !== k) : [...state.punts, k]; setState({ ...state, punts: p }, { undoable: false }); });
  document.querySelectorAll('[data-pick-amb]').forEach(b => b.onclick = () => { const a = pendingAmbiguous; pendingAmbiguous = null; try { state = E.draftPlayer(state, b.dataset.pickAmb); } catch (e) { notify(e.message); } runTakenQueue(a.names, a.index + 1); });
  const sk = $('#skipAmb'); if (sk) sk.onclick = () => { const a = pendingAmbiguous; pendingAmbiguous = null; runTakenQueue(a.names, a.index + 1); };
  const cm = $('#closeModal'); if (cm) cm.onclick = () => { detailId = null; render(); };
  const md = $('#modal'); if (md) md.onclick = e => { if (e.target === md) { detailId = null; render(); } };
  const u = $('#undo'); if (u) u.onclick = () => { if (history.length) { state = history.pop(); save(); render(); } else setState(E.undoLastPick(state), { undoable: false }); };
  const tf = $('#takenForm'); if (tf) tf.onsubmit = e => { e.preventDefault(); const v = $('#takenInput').value; processTaken(v); };
  const s = $('#search'); if (s) { s.oninput = () => { search = s.value; const pos = s.selectionStart; render(); const n = $('#search'); n.focus(); n.setSelectionRange(pos, pos); }; }
  const ss = $('#slotSel'); if (ss) ss.onchange = () => setState({ ...state, mySlot: +ss.value }, { undoable: false });
  const ul = $('#useLive'); if (ul) ul.onchange = () => setState({ ...state, useLive: ul.checked }, { undoable: false });
  const gp = $('#gpw'); if (gp) gp.onchange = () => setState({ ...state, gpWeight: gp.checked }, { undoable: false });
  const rs = $('#reset'); if (rs) rs.onclick = () => ask({ text: 'Clear ALL picks and start over? This cannot be undone.', buttons: [{ label: 'Clear everything', primary: true, onClick: () => { history = []; dialog = null; setState(E.createState({ mySlot: state.mySlot, teamNames: state.teamNames }), { undoable: false }); } }, { label: 'Keep my draft' }] });
  const uo = $('#unknownOther'); if (uo) uo.onclick = () => ask({ text: 'Player name (not in the pool) taken by the team on the clock:', input: 'text', placeholder: 'e.g. Jaden Ivey', buttons: [{ label: 'Log pick', primary: true, onClick: name => { if (!name) return; const id = 'unk-' + Date.now(); PLAYERS.push({ id, name: name + ' (unlisted)', team: '?', positions: ['Util'], gp: 60 }); dialog = null; try { setState(E.draftPlayer(state, id)); } catch (e) { notify(e.message); } } }, { label: 'Cancel' }] });
  document.querySelectorAll('[data-dlg]').forEach(b => b.onclick = () => { const d = dialog; const btn = d.buttons[+b.dataset.dlg]; const v = $('#dlgInput')?.value; dialog = null; if (btn.onClick) btn.onClick(v); if (dialog === null) render(); });
  const si = $('#shotInput'); if (si) si.onchange = () => { const f = si.files && si.files[0]; if (f) readScreenshot(f); };
  const pb = $('#pasteBox'); if (pb) {
    const fromItems = (dt) => { if (!dt) return null; for (const f of dt.files || []) if (f.type.startsWith('image/')) return f; for (const it of dt.items || []) if (it.kind === 'file' && it.type.startsWith('image/')) return it.getAsFile(); return null; };
    pb.onpaste = e => { const f = fromItems(e.clipboardData); if (f) { e.preventDefault(); readScreenshot(f); } };
    pb.oninput = () => { const img = pb.querySelector('img'); if (img && /^data:image\//.test(img.src)) { const [meta, b64] = img.src.split(','); const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); readScreenshot(new Blob([u8], { type: meta.slice(5).split(';')[0] })); } else if (img) { notify('Pasted image could not be read here. Try Photos → Share → Copy, then paste again.'); } pb.textContent = 'Long-press here → Paste screenshot'; };
    pb.onfocus = () => { if (pb.textContent.startsWith('Long-press')) pb.textContent = ''; };
    pb.onblur = () => { if (!pb.textContent.trim()) pb.textContent = 'Long-press here → Paste screenshot'; };
  }
  const sb = $('#shotBtn'); if (sb) sb.onclick = () => { const i = $('#shotInput'); if (i) i.click(); else notify('Picker not ready yet'); };
  const sc = $('#shotCancel'); if (sc) sc.onclick = () => shot.ctl?.abort();
  const rr = $('#qpReread'); if (rr) rr.onclick = () => readScreenshot(shot.file, { careful: true });
  const qc = $('#qpClear'); if (qc) qc.onclick = () => { shot = { status: 'idle' }; render(); };
  const qa = $('#qpApply'); if (qa) qa.onclick = () => applyShot();
  document.querySelectorAll('[data-qp-draft]').forEach(b => b.onclick = () => { if (!state.mySlot) { notify('Set your draft slot first.'); return; } applyShot({ draftId: b.dataset.qpDraft }); });
  document.querySelectorAll('[data-prop]').forEach(cb => cb.onchange = () => { shot.proposals[+cb.dataset.prop].on = cb.checked; shot.rec = tentativeRec(shot.proposals, ctx()); render(); });
  document.querySelectorAll('[data-amb-add]').forEach(b => b.onclick = () => { const id = b.dataset.ambAdd; const c2 = ctx(); const p = c2.byId[id]; if (!p) return; shot.ambiguous = shot.ambiguous.filter(a => !a.candidates.some(x => x.id === id)); if (!E.draftedIds(state).has(id) && !shot.proposals.some(x => x.player.id === id)) shot.proposals.push({ type: 'taken', player: p, pick: null, on: true }); shot.rec = tentativeRec(shot.proposals, c2); render(); });
  const st = $('#startTimer'); if (st) st.onclick = () => { timerEnd = Date.now() + 60000; tick(); };
}
function tick() {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const el = $('#timer'); if (!el || !timerEnd) { clearInterval(timerHandle); return; }
    const t = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    el.textContent = t + 's'; el.classList.toggle('hot', t <= 15);
    if (t <= 0) { clearInterval(timerHandle); timerEnd = null; render(); }
  }, 250);
}

render();
detectVision();
loadLiveStats();
window.__war = { analyseShot: (parsed) => analyseShot(parsed, ctx()), getState: () => state, setShot: (v) => { shot = v; render(); } };
