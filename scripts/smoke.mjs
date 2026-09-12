#!/usr/bin/env node
/**
 * End-to-end check: start a game in a real browser, play a few turns, and take
 * screenshots. Run the server first (`npm start`), then `node scripts/smoke.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? path.resolve(here, '../.smoke');
const base = process.env.SMOKE_URL ?? 'http://localhost:5173';

const problems = [];

// Use a pre-installed Chromium when the environment provides one whose build
// does not match this Playwright version.
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(
  fs.existsSync(executablePath) ? { executablePath } : {},
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));

const step = async (name, fn) => {
  process.stdout.write(`· ${name}… `);
  await fn();
  console.log('ok');
};

await step('load start screen', async () => {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#nation-list .nation-item');
});
await page.screenshot({ path: path.join(outDir, '1-start.png') });

await step('choose Korea and begin', async () => {
  await page.fill('#nation-search', '한국');
  await page.click('#nation-list .nation-item');
  await page.fill('#seed', 'smoke-test');
  await page.click('#start-btn');
  await page.waitForSelector('#shell:not([hidden])');
  await page.waitForTimeout(2200); // map projection + first render
});
await page.screenshot({ path: path.join(outDir, '2-map.png') });

await step('map drew real territory', async () => {
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('map');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return { colours: seen.size, width: canvas.width };
  });
  if (painted.colours < 8) throw new Error(`map looks blank (${painted.colours} colours)`);
});

await step('inspect a province', async () => {
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.42);
  await page.waitForTimeout(400);
});

await step('queue an order and resolve three turns', async () => {
  for (let turn = 0; turn < 3; turn += 1) {
    await page.click('#turn-btn');
    await page.waitForFunction(() => document.getElementById('map-busy').hidden, null, { timeout: 60000 });
    await page.waitForTimeout(300);
  }
  const label = await page.textContent('#date-label');
  if (!/4턴/.test(label)) throw new Error(`expected to be on turn 4, got "${label}"`);
});
await page.screenshot({ path: path.join(outDir, '3-after-turns.png') });

await step('dark theme', async () => {
  await page.click('#theme-btn');
  await page.waitForTimeout(600);
});
await page.screenshot({ path: path.join(outDir, '4-dark.png') });

await step('zoom in', async () => {
  await page.click('#home-btn');
  await page.waitForTimeout(1200);
});
await page.screenshot({ path: path.join(outDir, '5-zoomed.png') });

await step('phone width', async () => {
  await page.setViewportSize({ width: 420, height: 860 });
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 2) throw new Error(`horizontal overflow of ${overflow}px at 420px wide`);
});
await page.screenshot({ path: path.join(outDir, '6-narrow.png'), fullPage: false });

await browser.close();

console.log(`\n스크린샷: ${outDir}`);
if (problems.length) {
  console.log('\n브라우저 오류:');
  for (const problem of [...new Set(problems)]) console.log(`  ! ${problem}`);
  process.exit(1);
}
console.log('브라우저 오류 없음.');
