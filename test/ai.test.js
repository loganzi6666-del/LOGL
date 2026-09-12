import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorld } from '../src/game/world.js';
import { newGame, recomputeAll } from '../src/game/state.js';
import { Rng } from '../src/game/rng.js';
import { resolveTurn } from '../src/game/engine.js';
import { validateOrders } from '../src/game/orders.js';
import { heuristicOrders } from '../src/ai/heuristic.js';
import { selectThinkingNations } from '../src/ai/nation.js';
import { buildNationContext, orderReference } from '../src/ai/context.js';
import { localSummary } from '../src/ai/narrator.js';
import { arbiterSchema, nationDecisionSchema, orderSchema } from '../src/ai/schema.js';

const world = loadWorld();

function fresh(seed = 'ai-test', playerNation = 'KR') {
  const state = newGame({ playerNation, seed });
  recomputeAll(state, world);
  return state;
}

/** Run the whole world on rules for `turns` months. */
function runHeuristic(state, turns, seed = 7) {
  const rng = new Rng(seed);
  for (let i = 0; i < turns; i += 1) {
    const orders = {};
    for (const nation of Object.values(state.nations)) {
      if (!nation.alive || nation.isPlayer) continue;
      const raw = heuristicOrders(state, world, nation.iso2, rng);
      if (!raw.length) continue;
      const { accepted } = validateOrders(state, world, nation.iso2, raw);
      if (accepted.length) orders[nation.iso2] = accepted;
    }
    resolveTurn(state, world, orders);
  }
}

test('the rule-based AI only ever issues orders the engine accepts', () => {
  const state = fresh('legality');
  const rng = new Rng(11);
  let issued = 0;
  let refused = 0;

  for (let turn = 0; turn < 12; turn += 1) {
    const orders = {};
    for (const nation of Object.values(state.nations)) {
      if (!nation.alive || nation.isPlayer) continue;
      const raw = heuristicOrders(state, world, nation.iso2, rng);
      if (!raw.length) continue;
      const { accepted, rejected } = validateOrders(state, world, nation.iso2, raw);
      issued += raw.length;
      refused += rejected.length;
      if (accepted.length) orders[nation.iso2] = accepted;
    }
    resolveTurn(state, world, orders);
  }

  assert.ok(issued > 50, `the AI should be doing something (issued ${issued})`);
  // A few rejections are expected — money spent earlier in the same turn, a
  // province lost between planning and validation — but not a flood of them.
  assert.ok(refused / issued < 0.2, `too many illegal orders: ${refused}/${issued}`);
});

test('the world does not sit still: wars start, and they end', () => {
  const state = fresh('dynamism');
  runHeuristic(state, 60);

  const declarations = state.log.filter((entry) => entry.kind === 'war');
  const settlements = state.log.filter((entry) => entry.kind === 'peace' || entry.kind === 'capitulation');

  assert.ok(declarations.length > 0, 'five years should see at least one war begin');
  assert.ok(settlements.length > 0, 'and at least one end');

  // Fragile states should be the ones getting attacked, not Switzerland.
  assert.ok(state.nations.CH.alive);
  assert.equal(state.nations.CH.atWarWith.length, 0, 'Switzerland has no business being at war');
});

test('peacetime stability settles at each nation\'s own level, not at perfect calm', () => {
  const state = fresh('stability');
  runHeuristic(state, 36);

  // A wealthy democracy and a military junta should not converge.
  assert.ok(state.nations.CH.stability > state.nations.MM.stability + 15,
    `Switzerland ${state.nations.CH.stability} vs Myanmar ${state.nations.MM.stability}`);
  for (const nation of Object.values(state.nations)) {
    if (!nation.alive) continue;
    assert.ok(nation.stability >= 0 && nation.stability <= 100, `${nation.iso2} stability out of range`);
  }
});

test('the AI spends its thinking budget on the nations that matter to the player', () => {
  const state = fresh('selection');

  const peacetime = selectThinkingNations(state, world, 10);
  assert.ok(peacetime.includes('KP'), 'North Korea is the player\'s only neighbour');
  assert.ok(peacetime.includes('US'), 'and the United States its ally');
  assert.ok(!peacetime.includes('KR'), 'the player does not think for themselves');

  // Declaring war should pull the enemy to the very front of the queue.
  resolveTurn(state, world, {
    KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 'test' }],
  });
  assert.equal(selectThinkingNations(state, world, 10)[0], 'KP');
});

test('a nation briefing states only what the engine can verify', () => {
  const state = fresh('briefing');
  resolveTurn(state, world, { KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 'test' }] });

  const context = buildNationContext(state, world, 'KR');
  assert.match(context, /## 우리나라: 한국 \(KR\)/);
  assert.match(context, /공격 가능 지역/, 'a nation at war should be told where it can attack');
  assert.match(context, /KP-\d\d/, 'and be given real province codes');

  // Every province code offered as an attack target must actually be attackable.
  const offered = [...context.matchAll(/^- (\w\w-\d\d) /gm)].map((m) => m[1]);
  for (const id of offered) {
    assert.ok(state.provinces[id], `${id} should exist`);
  }

  assert.match(orderReference(), /OFFENSIVE/);
});

test('schemas are strict-mode safe for both providers', () => {
  // Both providers require every property to be listed in `required`.
  for (const schema of [orderSchema, nationDecisionSchema, arbiterSchema]) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      'every property must be required; optional fields are nullable instead',
    );
  }
  // Order fields that only apply sometimes must accept null.
  assert.deepEqual(orderSchema.properties.from.type, ['string', 'null']);
  assert.equal(orderSchema.properties.type.type, 'string', 'the order type itself is never null');
});

test('the game is playable with no API key at all', () => {
  const state = fresh('offline');
  const report = resolveTurn(state, world, {
    KR: [{ type: 'INVEST', target: 'economy', amount: 5 }],
  });
  const summary = localSummary(state, world, report);
  assert.ok(summary.headline);
  assert.equal(summary.offline, true);
});
