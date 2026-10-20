// Screenshot quick-pick workflow test. The viewer's `sample` capability cannot run outside claude.ai,
// so this injects a mock window.claude whose sample.json returns scripted screenshot readings.
// It exercises everything around the model call: proposals, confirmation, ambiguity, duplicates,
// a player drafted between screenshots, conflicts, pick-number sanity and undo.
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const exe = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => {
  window.__shots = [];
  const sample = async () => ({ text: '', truncated: false });
  sample.json = async (input, opts) => {
    window.__lastPrompt = input; window.__lastOpts = { tier: opts.modelTier, images: opts.images?.length };
    const next = window.__shots.shift(); if (!next) throw { code: 'invalid_json', message: 'no scripted shot' };
    if (next.reject) throw next.reject;
    return next;
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/png', 'image/jpeg'] } });
  window.claude = { use: async (name) => (name === 'sample' ? sample : null) };
});
await page.goto('file://' + resolve('dist/index.html'));
await page.click('[data-slot="5"]'); await page.click('#startDraft');
await page.waitForSelector('#shotInput', { state: 'attached' });
assert.ok(await page.$('label[for=shotInput]'), 'quick pick button visible when images are supported');

const upload = async (shot) => {
  await page.evaluate(s => window.__shots.push(s), shot);
  await page.setInputFiles('#shotInput', 'dist/screenshot-draft.png');
  await page.waitForSelector('.qp-out, .qp .flag', { timeout: 5000 });
};

// Shot 1: draft results showing 4 picks, one ambiguous name, one unreadable, header says pick 5
await upload({ screen: 'draft_results', round: 1, pick: 5, partial: true, uncertain: ['row 3 blurry'],
  players: [
    { name: 'Nikola Jokic', status: 'drafted', pick: 1 }, { name: 'Victor Wembanyama', status: 'drafted', pick: 2 },
    { name: 'Murray', status: 'drafted', pick: 3 }, { name: 'Shai Gilgeous-Alexander', status: 'drafted', pick: 4 },
    { name: 'Zzyzx Unknown', status: 'drafted', pick: null }, { name: 'Tyrese Maxey', status: 'available' },
  ] });
let txt = await page.textContent('.qp');
assert.ok(/BEST PICK NOW/.test(txt) && /BACKUP 1/.test(txt) && /BACKUP 2/.test(txt), 'three recommendations shown');
assert.ok(/WHY:/.test(txt), 'why sentence');
assert.ok(/Ambiguous names/.test(txt) && /Jamal Murray/.test(txt), 'ambiguous Murray flagged, not auto-applied');
assert.ok(/Not in pool: Zzyzx Unknown/.test(txt), 'unknown name reported, not invented');
assert.ok(/Apply 3 updates/.test(txt), 'three confirmed-name proposals');
assert.ok(/missing/.test(txt), 'pick-number mismatch flagged (header pick 5 vs app pick 4 after 3 updates)');
const best = await page.textContent('.qp-row:first-child .qp-name');
assert.ok(!/Jokic|Wembanyama|Gilgeous/.test(best), 'drafted players not recommended: ' + best);
assert.equal((await page.evaluate(() => window.__war.getState().picks.length)), 0, 'nothing logged before confirmation');
assert.equal((await page.evaluate(() => window.__lastOpts.images)), 1, 'image passed to the model');
// Resolve the ambiguous Murray as Jamal → becomes a 4th proposal
await page.click('[data-amb-add="jmurray"]');
assert.ok(/Apply 4 updates/.test(await page.textContent('.qp')));
// Untick one proposal: recommendation recomputes and update count drops
await page.click('[data-prop="3"]');
assert.ok(/Apply 3 updates/.test(await page.textContent('.qp')));
await page.click('[data-prop="3"]');
// One-tap confirm: "I drafted <best>" applies the 4 updates then my pick (#5)
await page.click('.qp-row:first-child [data-qp-draft]');
await page.waitForFunction(() => /Pick\s*6/.test(document.querySelector('.hdr').textContent));
let st = await page.evaluate(() => window.__war.getState());
assert.equal(st.picks.length, 5);
assert.equal(st.picks[4].slot, 5, 'my pick logged to my slot');
assert.ok((await page.textContent('.roster')).includes(best.split(' ')[0]), 'roster updated after confirmation');
// Undo reverts the whole batch in one tap
await page.click('#undo');
await page.waitForFunction(() => /Pick\s*1\b/.test(document.querySelector('.hdr').textContent));
assert.equal((await page.evaluate(() => window.__war.getState().picks.length)), 0, 'undo restored pre-screenshot state');
// Re-apply via Apply (no draft) then draft manually
await upload({ screen: 'draft_results', round: 1, pick: 5, partial: false, players: [
  { name: 'Nikola Jokic', status: 'drafted', pick: 1 }, { name: 'Victor Wembanyama', status: 'drafted', pick: 2 },
  { name: 'Jamal Murray', status: 'drafted', pick: 3 }, { name: 'Shai Gilgeous-Alexander', status: 'drafted', pick: 4 }] });
await page.click('#qpApply');
await page.waitForFunction(() => /Pick\s*5\b/.test(document.querySelector('.hdr').textContent));
// Duplicate upload of the same screenshot: nothing new, skipped count shown, state unchanged
await upload({ screen: 'draft_results', round: 1, pick: 5, partial: false, players: [
  { name: 'Nikola Jokic', status: 'drafted', pick: 1 }, { name: 'Victor Wembanyama', status: 'drafted', pick: 2 },
  { name: 'Jamal Murray', status: 'drafted', pick: 3 }, { name: 'Shai Gilgeous-Alexander', status: 'drafted', pick: 4 }] });
txt = await page.textContent('.qp');
assert.ok(/No new picks/.test(txt) && /4 already logged/.test(txt), 'duplicate screenshot is a no-op: ' + txt.slice(0, 200));
assert.equal((await page.evaluate(() => window.__war.getState().picks.length)), 4);
// Player drafted between screenshots: Maxey (the likely best) is taken via TAKEN box, next shot's best must change
const bestBefore = await page.textContent('.qp-row:first-child .qp-name');
await page.click('#qpClear');
await page.fill('#takenInput', 'TAKEN: ' + bestBefore.split('·')[0].replace(/\s+[A-Z]{3}.*$/, '').trim());
await page.click('#takenForm button[type=submit]');
await page.waitForFunction(() => /Pick\s*6\b/.test(document.querySelector('.hdr').textContent));
await upload({ screen: 'available_players', round: 1, pick: 6, partial: true, players: [{ name: bestBefore.split(' ').slice(0, 2).join(' '), status: 'available' }] });
txt = await page.textContent('.qp');
const bestAfter = await page.textContent('.qp-row:first-child .qp-name');
assert.notEqual(bestAfter.split('·')[0].trim(), bestBefore.split('·')[0].trim(), 'best pick recalculated after target taken');
assert.ok(/Conflicts:/.test(txt) && /looks available/.test(txt), 'available-vs-drafted conflict flagged: ' + txt.slice(0, 300));
// Model failure path: readable error, no state change
await upload({ reject: { code: 'invalid_json', message: 'bad' } });
assert.ok(/could not produce a readable list/i.test(await page.textContent('.qp')));
assert.equal((await page.evaluate(() => window.__war.getState().picks.length)), 5);
await page.screenshot({ path: 'dist/screenshot-quickpick.png' });
await browser.close();
assert.deepEqual(errors, [], 'console/page errors: ' + errors.join(' | '));
console.log('Quick pick smoke test passed');
