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

await step('type a Korean order and have it understood for free', async () => {
  await page.fill('#command', '북한에 선전포고하고 5개 사단을 증강하라');
  await page.click('#interpret-btn');
  await page.waitForFunction(() => document.getElementById('map-busy').hidden, null, { timeout: 60000 });
  await page.waitForTimeout(300);

  const pending = await page.textContent('#pending');
  if (!/선전포고/.test(pending ?? '')) {
    throw new Error(`the parser did not produce a declaration: ${pending}`);
  }
  if (!/사단 편성/.test(pending ?? '')) {
    throw new Error(`the parser did not produce a recruitment: ${pending}`);
  }

  await page.click('#turn-btn');
  await page.waitForFunction(() => document.getElementById('map-busy').hidden, null, { timeout: 60000 });
  await page.waitForTimeout(400);

  const atWar = await page.evaluate(() => window.__logl.state.player.atWarWith);
  if (!atWar.includes('KP')) throw new Error(`expected war with KP, got ${atWar.join(',')}`);
});
await page.screenshot({ path: path.join(outDir, '2b-korean-command.png') });

await step('a question is answered without spending a turn', async () => {
  const before = await page.evaluate(() => window.__logl.state.meta.turn);
  await page.fill('#command', '북한 군사력이 어때?');
  await page.click('#interpret-btn');
  await page.waitForFunction(() => document.getElementById('map-busy').hidden, null, { timeout: 60000 });
  await page.waitForTimeout(300);

  const reply = await page.textContent('#pending');
  if (!/사단|병력/.test(reply ?? '')) throw new Error(`no answer given: ${reply}`);
  const after = await page.evaluate(() => window.__logl.state.meta.turn);
  if (after !== before) throw new Error('a question should not advance the turn');
});

await step('resolve three more turns', async () => {
  const before = await page.evaluate(() => window.__logl.state.meta.turn);
  for (let turn = 0; turn < 3; turn += 1) {
    await page.click('#turn-btn');
    await page.waitForFunction(() => document.getElementById('map-busy').hidden, null, { timeout: 60000 });
    await page.waitForTimeout(300);
  }
  const after = await page.evaluate(() => window.__logl.state.meta.turn);
  if (after !== before + 3) throw new Error(`expected turn ${before + 3}, got ${after}`);
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

await step('fight a war and see the map change', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);

  // Drive the turn loop through the API, then check that the browser actually
  // paints the result. This is the whole premise of the game: territory taken in
  // a war shows up on the map.
  const outcome = await page.evaluate(async () => {
    const post = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${url} -> ${response.status}`);
      return response.json();
    };

    const app = window.__logl;
    const me = app.state.meta.playerNation;
    const enemy = app.state.player.neighbours?.[0] ?? 'KP';

    let result = await post('/api/turn', {
      orders: [{ type: 'DECLARE_WAR', target: enemy, casusBelli: 'smoke test' }],
    });

    const held = (state, owner) =>
      Object.entries(state.provinces).filter(([, p]) => p.c === owner).map(([id]) => id);

    let captured = null;
    for (let turn = 0; turn < 45 && !captured; turn += 1) {
      const state = result.state;
      const orders = [];

      // Concentrate everything on one border province, then push.
      const staging = state.player.capitalProvince;
      for (const army of state.armies) {
        if (army.owner !== me || army.province === staging) continue;
        const hop = (app.geometry.byId.get(army.province)?.neighbours ?? []).find(
          (id) => state.provinces[id]?.c === me,
        );
        if (hop) orders.push({ type: 'MOVE', from: army.province, to: hop, commit: army.strength });
      }

      const massed = state.armies
        .filter((a) => a.owner === me && a.province === staging)
        .reduce((sum, a) => sum + a.strength, 0);
      const target = (app.geometry.byId.get(staging)?.neighbours ?? []).find(
        (id) => state.provinces[id]?.c === enemy,
      );
      if (target && massed > 22) {
        orders.push({ type: 'OFFENSIVE', from: staging, to: target, commit: massed });
      } else {
        orders.push({ type: 'RECRUIT', divisions: 2 });
      }

      result = await post('/api/turn', { orders });
      const mine = held(result.state, me);
      captured = mine.find((id) => result.state.provinces[id].o === enemy) ?? null;
    }

    if (captured) {
      // Push the new state through the app's own update path, so the panels and
      // the map agree — the same thing that happens when a turn ends normally.
      app.applyState(result.state);
      app.map.highlightChanges(result.report?.mapChanges ?? []);
      app.map.zoomTo(captured, 14);
    }
    return { enemy, captured, turn: result.state.meta.turn };
  });

  if (!outcome.captured) throw new Error('no territory was taken in 45 turns');
  await page.waitForTimeout(1600);

  // The occupied province must be drawn with the occupier's hatch, which means
  // its pixels carry more than one colour.
  const painted = await page.evaluate((provinceId) => {
    const m = window.__logl.map;
    const province = m.byId.get(provinceId);
    const [[x0, y0], [x1, y1]] = province.bounds;
    const a = m.transform.apply([x0, y0]);
    const b = m.transform.apply([x1, y1]);
    const left = Math.max(0, Math.round(Math.min(a[0], b[0]) * m.dpr));
    const top = Math.max(0, Math.round(Math.min(a[1], b[1]) * m.dpr));
    const width = Math.min(m.canvas.width - left, Math.round(Math.abs(b[0] - a[0]) * m.dpr)) || 1;
    const height = Math.min(m.canvas.height - top, Math.round(Math.abs(b[1] - a[1]) * m.dpr)) || 1;
    const { data } = m.ctx.getImageData(left, top, width, height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { colours: seen.size, provinceId };
  }, outcome.captured);

  if (painted.colours < 3) {
    throw new Error(`occupied province ${painted.provinceId} drew in ${painted.colours} colour(s)`);
  }
  console.log(`[${outcome.enemy} ${outcome.captured} 점령, ${outcome.turn}턴]`);
});
await page.screenshot({ path: path.join(outDir, '7-conquest.png') });

await browser.close();

console.log(`\n스크린샷: ${outDir}`);
if (problems.length) {
  console.log('\n브라우저 오류:');
  for (const problem of [...new Set(problems)]) console.log(`  ! ${problem}`);
  process.exit(1);
}
console.log('브라우저 오류 없음.');
