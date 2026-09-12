/**
 * The game server.
 *
 * Holds one playthrough in memory, serves the map geometry once, and exposes the
 * turn loop over HTTP. Everything that changes the world goes through
 * `Session`, so the browser can never write state directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { gzipSync } from 'node:zlib';

import { config, hasCredentials, isLocalModel, ROOT } from './config.js';
import { loadWorld } from './game/world.js';
import { Session } from './game/session.js';

const WORLD_PATH = path.join(ROOT, 'data', 'world.json');
const BUNDLE_PATH = path.join(ROOT, 'public', 'dist', 'app.js');

/**
 * Neither the map nor the browser bundle is committed — both are generated. So
 * that a fresh checkout needs nothing but `npm install && npm start`, build
 * whichever is missing before serving anything.
 */
function ensureBuilt(label, outputPath, script, hint) {
  if (fs.existsSync(outputPath)) return;
  console.log(`처음 실행이라 ${label} 준비 중입니다. 잠시만 기다려 주세요…`);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    stdio: 'inherit',
  });
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    throw new Error(`${label} 준비에 실패했습니다. 터미널에서 "${hint}"를 직접 실행해 보세요.`);
  }
}

ensureBuilt('세계 지도 (약 10초)', WORLD_PATH, 'build-world.mjs', 'npm run build:world');
ensureBuilt('화면 파일', BUNDLE_PATH, 'build-client.mjs', 'npm run build:client');

const world = loadWorld();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

/** In-memory game. One player, one world. */
let session = null;

const requireSession = (res) => {
  if (!session) {
    res.status(409).json({ error: '진행 중인 게임이 없습니다. 먼저 새 게임을 시작하세요.' });
    return false;
  }
  return true;
};

const fail = (res, error, status = 400) => {
  const message = String(error?.message ?? error);
  res.status(status).json({ error: message });
};

// ── Static world geometry ───────────────────────────────────────────────────

/**
 * The map never changes, so it is built once, gzipped once, and cached with a
 * long max-age. Only ownership (a few KB) travels each turn.
 */
const geometryPayload = (() => {
  const provinces = world.provinceList.map((province) => ({
    id: province.id,
    name: province.name,
    core: province.coreOwner,
    centre: province.centre,
    population: province.population,
    area: province.areaKm2,
    climate: province.climate,
    coastal: province.coastal,
    cities: province.cities,
    neighbours: province.neighbours,
    geometry: province.geometry,
  }));

  const nations = {};
  for (const [iso2, nation] of world.nations) {
    nations[iso2] = {
      iso2,
      name: nation.name,
      nameKo: nation.nameKo,
      region: nation.region,
      capitalProvince: nation.capitalProvince,
    };
  }

  // Which nations border which, so the client can colour the map so that no two
  // neighbours share a colour.
  const adjacency = {};
  for (const province of world.provinceList) {
    for (const neighbour of province.neighbours) {
      const other = world.province(neighbour)?.coreOwner;
      if (!other || other === province.coreOwner) continue;
      (adjacency[province.coreOwner] ??= []).push(other);
    }
  }
  for (const [key, list] of Object.entries(adjacency)) {
    adjacency[key] = [...new Set(list)];
  }

  const body = JSON.stringify({ provinces, nations, adjacency, source: world.source });
  return { raw: body, gzip: gzipSync(body, { level: 6 }) };
})();

app.get('/api/geometry', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if ((req.headers['accept-encoding'] ?? '').includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(geometryPayload.gzip);
  } else {
    res.end(geometryPayload.raw);
  }
});

// ── Game lifecycle ──────────────────────────────────────────────────────────

/** Nations worth offering on the start screen, strongest first. */
app.get('/api/playable', (req, res) => {
  const rows = [];
  for (const [iso2, nation] of world.nations) {
    if (nation.sovereign) continue;
    if (!nation.gdp || !nation.capitalProvince) continue;
    rows.push({
      iso2,
      name: nation.nameKo,
      nameEn: nation.name,
      region: nation.region,
      gdp: nation.gdp,
      population: nation.population,
      active: nation.military?.active ?? 0,
      nukes: nation.military?.nukes ?? 0,
      doctrine: nation.doctrine,
      government: nation.government,
    });
  }
  rows.sort((a, b) => b.gdp - a.gdp);
  res.json({
    nations: rows,
    aiEnabled: hasCredentials(),
    provider: config.provider,
    // "free" covers both no key at all (built-in parser) and a local model.
    free: !hasCredentials() || isLocalModel(),
  });
});

app.post('/api/game/new', (req, res) => {
  try {
    session = Session.create({
      playerNation: String(req.body?.nation ?? 'KR').toUpperCase(),
      seed: req.body?.seed ? String(req.body.seed) : null,
      startYear: Number(req.body?.startYear) || 2025,
    });
    res.json(session.snapshot());
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/state', (req, res) => {
  if (!requireSession(res)) return;
  res.json(session.snapshot());
});

// ── The turn loop ───────────────────────────────────────────────────────────

/** Read a natural-language instruction without committing to it. */
app.post('/api/interpret', async (req, res) => {
  if (!requireSession(res)) return;
  const instruction = String(req.body?.instruction ?? '').trim();
  if (!instruction) return fail(res, new Error('지시 내용이 비어 있습니다.'));
  try {
    res.json(
      await session.interpret(instruction, {
        selectedProvince: req.body?.selectedProvince ? String(req.body.selectedProvince) : null,
      }),
    );
  } catch (error) {
    fail(res, error, 502);
  }
});

/** Resolve the month. */
app.post('/api/turn', async (req, res) => {
  if (!requireSession(res)) return;
  try {
    const result = await session.advanceTurn({
      orders: Array.isArray(req.body?.orders) ? req.body.orders : [],
      instruction: req.body?.instruction ? String(req.body.instruction) : null,
      useLlm: req.body?.useLlm ?? hasCredentials(),
    });
    res.json({ ...result, state: session.snapshot() });
  } catch (error) {
    fail(res, error, 500);
  }
});

/** Check an order the UI built, so buttons can grey out before being pressed. */
app.post('/api/validate', (req, res) => {
  if (!requireSession(res)) return;
  try {
    const { validateOrders } = req.app.locals;
    res.json(validateOrders(session.state, world, session.state.meta.playerNation, req.body?.orders ?? []));
  } catch (error) {
    fail(res, error);
  }
});

// ── Saves ───────────────────────────────────────────────────────────────────

app.get('/api/saves', (req, res) => {
  try {
    res.json({ saves: Session.list() });
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/save', (req, res) => {
  if (!requireSession(res)) return;
  try {
    res.json(session.save(String(req.body?.name ?? 'autosave')));
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/load', (req, res) => {
  try {
    session = Session.load(String(req.body?.name ?? ''));
    res.json(session.snapshot());
  } catch (error) {
    fail(res, error, 404);
  }
});

// Wire the validator in for /api/validate without a circular import at module load.
const { validateOrders } = await import('./game/orders.js');
app.locals.validateOrders = validateOrders;

app.listen(config.port, () => {
  const keyed = hasCredentials();
  console.log('');
  console.log(`  LOGL — AI 지정학 시뮬레이션`);
  console.log(`  http://localhost:${config.port}`);
  console.log('');
  console.log(`  지도: ${world.provinceList.length}개 주 / ${world.nations.size}개 국가`);
  if (!keyed) {
    console.log('  모드: 무료 — 한국어 명령 해석기와 규칙 기반 AI로 동작합니다. 설정할 것 없습니다.');
  } else {
    const model = config.provider === 'openai' ? config.openai.model : config.anthropic.model;
    console.log(
      `  모드: ${isLocalModel() ? '내 컴퓨터의 모델 (무료)' : config.provider} · ${model} · ` +
        `한 턴에 ${config.thinkingNations}개국이 직접 사고`,
    );
  }
  console.log('');
});
