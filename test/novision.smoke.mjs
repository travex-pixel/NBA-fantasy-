// Without the runtime capability (local file / GitHub copy) the app must say so instead of showing a dead upload button.
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('file://' + resolve('dist/index.html'));
await page.click('[data-slot="1"]'); await page.click('#startDraft');
await page.waitForFunction(() => /not available in this copy/.test(document.querySelector('.qp').textContent));
assert.equal(await page.$('#shotInput'), null, 'no upload control when images cannot be read');
await browser.close(); console.log('No-vision fallback test passed');
