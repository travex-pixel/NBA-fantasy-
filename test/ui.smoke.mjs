// Browser smoke test of the critical mobile flows against dist/index.html (file://).
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const exe = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', d => d.accept());
await page.goto('file://' + resolve('dist/index.html'));

// Setup: slot 4
await page.click('[data-slot="4"]');
await page.click('#startDraft');
await page.waitForSelector('.hdr');
assert.match(await page.textContent('.hdr'), /Pick\s*1/);
assert.match(await page.textContent('.hdr'), /#4/);
// no horizontal scroll
const sw = await page.evaluate(() => document.documentElement.scrollWidth); assert.ok(sw <= 390, 'no horizontal scroll: ' + sw);
// Best pick card renders
const best = await page.textContent('.cand.primary .cand-name');
assert.ok(best.length > 3);
// Mark 3 taken in one line
await page.fill('#takenInput', 'TAKEN: Nikola Jokic, Wembanyama, Shai Gilgeous-Alexander');
await page.click('#takenForm button[type=submit]');
await page.waitForFunction(() => /Pick\s*4/.test(document.querySelector('.hdr').textContent));
assert.match(await page.textContent('.hdr'), /YOU/);
const bestNow = await page.textContent('.cand.primary .cand-name');
assert.ok(!/Jokic|Wembanyama|Gilgeous/.test(bestNow), 'drafted players never recommended: ' + bestNow);
// Ambiguous name opens chooser
await page.fill('#takenInput', 'Murray');
await page.click('#takenForm button[type=submit]');
await page.waitForSelector('[data-pick-amb]');
const opts = await page.$$('[data-pick-amb]'); assert.ok(opts.length >= 3);
await page.click('#skipAmb');
assert.match(await page.textContent('.hdr'), /Pick\s*4/);
// Draft ME
await page.click('.cand.primary [data-draft-me]');
await page.waitForFunction(() => /Pick\s*5/.test(document.querySelector('.hdr').textContent));
const roster = await page.textContent('.roster'); assert.ok(roster.includes(bestNow.split(' ')[0]), 'roster updated');
// Undo
await page.click('#undo');
await page.waitForFunction(() => /Pick\s*4/.test(document.querySelector('.hdr').textContent));
// Players tab search
await page.click('[data-view="players"]');
await page.fill('#search', 'curry');
await page.waitForFunction(() => document.querySelectorAll('.prow').length === 1);
// Strategy tab renders sources
await page.click('[data-view="strategy"]');
assert.ok((await page.textContent('.main')).includes('Data & sources'));
// Persistence across reload
await page.reload();
await page.waitForSelector('.hdr');
assert.match(await page.textContent('.hdr'), /Pick\s*4/);
await page.screenshot({ path: 'dist/screenshot-draft.png', fullPage: false });
await browser.close();
assert.deepEqual(errors, [], 'console/page errors: ' + errors.join(' | '));
console.log('UI smoke test passed');
