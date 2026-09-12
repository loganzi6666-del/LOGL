import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorld, findLandPath } from '../src/game/world.js';
import { newGame, getRelation, areAtWar, recomputeAll } from '../src/game/state.js';
import { resolveTurn } from '../src/game/engine.js';
import { validateOrder } from '../src/game/orders.js';
import { findWar, computeWarScore } from '../src/game/diplomacy.js';
import { garrisonIn } from '../src/game/military.js';

const world = loadWorld();

function fresh(seed = 'test') {
  const state = newGame({ playerNation: 'KR', seed });
  recomputeAll(state, world);
  return state;
}

test('a new game starts from real-world figures', () => {
  const state = fresh();
  const kr = state.nations.KR;

  assert.equal(kr.nameKo, '한국');
  assert.ok(kr.gdp > 1500 && kr.gdp < 1900, `KR GDP out of range: ${kr.gdp}`);
  assert.ok(kr.divisions > 30 && kr.divisions < 36, `KR divisions: ${kr.divisions}`);
  assert.equal(state.provinces[kr.capitalProvince].owner, 'KR');

  // The two Koreas start hostile, Seoul is allied to Washington.
  assert.ok(getRelation(state, 'KR', 'KP') < -50);
  assert.ok(state.nations.KR.allies.includes('US'));

  // Every province is owned and controlled by somebody living.
  for (const [id, province] of Object.entries(state.provinces)) {
    assert.ok(state.nations[province.owner], `${id} has no owner nation`);
    assert.equal(province.owner, province.controller);
  }
});

test('orders that the map does not allow are refused', () => {
  const state = fresh();

  // Not at war yet.
  const premature = validateOrder(state, world, 'KR', {
    type: 'OFFENSIVE',
    from: 'KR-01',
    to: 'KP-02',
    commit: 5,
  });
  assert.equal(premature.ok, false);
  assert.match(premature.reason, /전쟁 상태가 아닙니다/);

  // Non-adjacent land attack, even at war.
  state.nations.KR.atWarWith.push('KP');
  state.nations.KP.atWarWith.push('KR');
  const farAway = validateOrder(state, world, 'KR', {
    type: 'OFFENSIVE',
    from: 'KR-03',
    to: 'KP-01',
    commit: 5,
  });
  assert.equal(farAway.ok, false, 'Busan should not be able to storm Pyongyang overland');

  // Spending money that is not there.
  const broke = validateOrder(state, world, 'KR', {
    type: 'INVEST',
    target: 'economy',
    amount: 99_999,
  });
  assert.equal(broke.ok, false);
  assert.match(broke.reason, /국고가 부족/);

  // Demanding land you do not hold.
  const greedy = validateOrder(state, world, 'KR', {
    type: 'PROPOSE_PEACE',
    target: 'KP',
    annex: ['KP-01'],
  });
  assert.equal(greedy.ok, false);
  assert.match(greedy.reason, /점령하지 않은/);

  // Nations without warheads cannot use them.
  const nuke = validateOrder(state, world, 'KR', { type: 'NUCLEAR_STRIKE', province: 'KP-01' });
  assert.equal(nuke.ok, false);
});

/** Orders that walk every army one step along the road to a staging province. */
function concentrateOn(state, staging) {
  const orders = [];
  for (const army of Object.values(state.armies)) {
    if (army.owner !== 'KR' || army.province === staging) continue;
    const path = findLandPath(world, army.province, staging, (id) => state.provinces[id].controller === 'KR');
    if (!path || path.length < 2) continue;
    orders.push({ type: 'MOVE', from: army.province, to: path[1], commit: army.strength });
  }
  return orders;
}

test('a war is fought, ground changes hands, and a peace transfers it', () => {
  const state = fresh('war-scenario');

  let report = resolveTurn(state, world, {
    KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: '핵 위협 제거' }],
  });
  assert.ok(areAtWar(state, 'KR', 'KP'), 'war should be under way');
  assert.ok(report.events.some((e) => e.kind === 'war'));
  assert.ok(findWar(state, 'KR', 'KP'));

  const staging = state.nations.KR.capitalProvince;
  const target = world
    .neighbours(staging)
    .find((id) => state.provinces[id].controller === 'KP');
  assert.ok(target, 'Seoul should border North Korean territory');

  // A frontal assault by whatever happens to be sitting in Seoul is not enough
  // against a dug-in defender, so mass the whole army first — as a player would.
  let captured = false;
  for (let turn = 0; turn < 40 && !captured; turn += 1) {
    const orders = [...concentrateOn(state, staging), { type: 'RECRUIT', divisions: 2 }];
    const massed = garrisonIn(state, staging, 'KR');
    if (massed > 25) {
      orders.push({ type: 'OFFENSIVE', from: staging, to: target, commit: massed });
    }
    resolveTurn(state, world, { KR: orders });
    if (state.provinces[target].controller === 'KR') captured = true;
  }

  assert.ok(captured, 'a concentrated offensive should take the province');
  // Occupation is not ownership: the map shows it held, not annexed.
  assert.equal(state.provinces[target].owner, 'KP');
  assert.equal(state.provinces[target].controller, 'KR');

  computeWarScore(state, world, findWar(state, 'KR', 'KP'));
  assert.ok(findWar(state, 'KR', 'KP').warScore > 0, 'Korea should be ahead on warscore');

  // Now take it at the negotiating table, pressing the offensive meanwhile.
  let annexed = false;
  for (let turn = 0; turn < 60 && !annexed; turn += 1) {
    const orders = [{ type: 'PROPOSE_PEACE', target: 'KP', annex: [target], reparations: 0 }];
    const front = Object.values(state.armies)
      .filter((a) => a.owner === 'KR' && a.strength > 4)
      .sort((a, b) => b.strength - a.strength)[0];
    if (front) {
      const next = world
        .neighbours(front.province)
        .find((id) => state.provinces[id].controller === 'KP');
      if (next) orders.push({ type: 'OFFENSIVE', from: front.province, to: next, commit: front.strength });
    }
    resolveTurn(state, world, { KR: orders });
    if (state.provinces[target].owner === 'KR') annexed = true;
    if (!areAtWar(state, 'KR', 'KP')) break;
  }

  assert.ok(annexed, 'a peace deal should eventually transfer ownership');
  assert.equal(state.provinces[target].owner, 'KR');
  assert.equal(state.provinces[target].controller, 'KR');
  assert.equal(areAtWar(state, 'KR', 'KP'), false, 'the war should be over');
});

test('the same seed and the same orders produce the same world', () => {
  const orders = {
    KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 'test' }],
    US: [{ type: 'INVEST', target: 'economy', amount: 40 }],
  };

  const runOnce = () => {
    const state = fresh('determinism');
    for (let i = 0; i < 6; i += 1) {
      resolveTurn(state, world, i === 0 ? orders : { KR: [{ type: 'RECRUIT', divisions: 1 }] });
    }
    return JSON.stringify({ provinces: state.provinces, nations: state.nations });
  };

  assert.equal(runOnce(), runOnce());
});

test('quiet turns stay stable over a long run', () => {
  const state = fresh('quiet');
  for (let i = 0; i < 24; i += 1) resolveTurn(state, world, {});

  const kr = state.nations.KR;
  assert.ok(kr.alive);
  assert.ok(Number.isFinite(kr.treasury), 'treasury must stay a number');
  assert.ok(kr.stability >= 0 && kr.stability <= 100);
  assert.ok(kr.gdp > 0);
  // Nobody should have quietly lost or gained territory without a war.
  assert.equal(state.provinces[kr.capitalProvince].owner, 'KR');
  assert.equal(state.wars.length, 0);
});
