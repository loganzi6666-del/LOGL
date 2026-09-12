/**
 * The free parser has to actually understand what a Korean player types.
 * These are the sentences a player writes, checked against the orders they mean.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorld } from '../src/game/world.js';
import { newGame, recomputeAll, areAtWar } from '../src/game/state.js';
import { resolveTurn } from '../src/game/engine.js';
import { parseCommand } from '../src/ai/localCommand.js';

const world = loadWorld();

function fresh(seed = 'local-cmd') {
  const state = newGame({ playerNation: 'KR', seed });
  recomputeAll(state, world);
  return state;
}

const parse = (state, text, options) => parseCommand(state, world, text, options);

test('Korean place names resolve to the right provinces', () => {
  const byId = new Map(world.provinceList.map((p) => [p.id, p]));
  assert.equal(byId.get('KR-01').nameKo, '서울');
  assert.equal(byId.get('KP-01').nameKo, '평양');
  assert.equal(byId.get('KP-04').nameKo, '개성');
  assert.equal(byId.get('JP-01').nameKo, '도쿄');
  assert.equal(byId.get('CN-12').nameKo, '베이징');
});

test('선전포고 — a declaration of war', () => {
  const state = fresh();
  const result = parse(state, '북한에 선전포고하라');

  assert.equal(result.isQuestion, false);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].type, 'DECLARE_WAR');
  assert.equal(result.orders[0].target, 'KP');

  resolveTurn(state, world, { KR: result.orders });
  assert.ok(areAtWar(state, 'KR', 'KP'));
});

test('두 가지 지시를 한 문장에 — declare war and attack in one sentence', () => {
  const state = fresh('combo');
  const result = parse(state, '북한에 선전포고하고 개성으로 전 병력을 투입하라');

  const types = result.orders.map((o) => o.type);
  assert.ok(types.includes('DECLARE_WAR'), `got ${types.join(',')}`);

  // The attack cannot be validated until the war exists, so it is refused now —
  // with a reason the player can act on — rather than silently dropped.
  const refusedAttack = result.rejected.some((r) => /전쟁 상태가 아닙니다/.test(r.reason));
  assert.ok(types.includes('OFFENSIVE') || refusedAttack);
});

test('공격 — attacking a named place picks a real launch point', () => {
  const state = fresh('attack');
  resolveTurn(state, world, { KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 't' }] });

  const result = parse(state, '개성을 공격하라');
  assert.equal(result.orders.length, 1);
  const order = result.orders[0];
  assert.equal(order.type, 'OFFENSIVE');
  assert.equal(order.to, 'KP-04', '개성 should resolve to KP-04');
  assert.equal(state.provinces[order.from].controller, 'KR', 'and launch from our own ground');
  assert.ok(world.neighbours(order.from).includes('KP-04'), 'which must be adjacent');
  assert.ok(order.commit > 0);
});

test('전 병력 — "everything we have" commits the whole garrison', () => {
  const state = fresh('all-in');
  resolveTurn(state, world, { KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 't' }] });

  const some = parse(state, '개성에 3개 사단으로 진격');
  const all = parse(state, '개성으로 전 병력 진격');
  assert.ok(all.orders[0].commit > some.orders[0].commit, 'all-in should commit more');
  assert.equal(some.orders[0].commit, 3);
});

test('나라 이름만 말해도 공격할 곳을 고른다', () => {
  const state = fresh('nation-attack');
  resolveTurn(state, world, { KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 't' }] });

  const result = parse(state, '북한을 공격하라');
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].type, 'OFFENSIVE');
  assert.equal(state.provinces[result.orders[0].to].controller, 'KP');
});

test('경제·군사·외교 지시', () => {
  const state = fresh('misc');

  const invest = parse(state, '경제에 10 투자하라');
  assert.deepEqual(
    invest.orders.map((o) => [o.type, o.target, o.amount]),
    [['INVEST', 'economy', 10]],
  );

  const research = parse(state, '군사 기술 연구에 투자하라');
  assert.equal(invest.orders.length, 1);
  assert.equal(research.orders[0]?.target, 'research');

  const recruit = parse(state, '5개 사단을 증강하라');
  assert.equal(recruit.orders[0].type, 'RECRUIT');
  assert.equal(recruit.orders[0].divisions, 5);

  const budget = parse(state, '국방비를 4%로 올려라');
  assert.equal(budget.orders[0].type, 'SET_DEFENCE_SHARE');
  assert.ok(Math.abs(budget.orders[0].value - 0.04) < 1e-9);

  const relations = parse(state, '일본과 관계를 개선하라');
  assert.equal(relations.orders[0].type, 'IMPROVE_RELATIONS');
  assert.equal(relations.orders[0].target, 'JP');
});

test('강화 제안은 실제로 점령한 땅만 요구한다', () => {
  const state = fresh('peace');
  resolveTurn(state, world, { KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 't' }] });

  // Nothing taken yet: the only honest offer is a white peace.
  const early = parse(state, '북한과 강화하라');
  assert.equal(early.orders[0].type, 'PROPOSE_PEACE');
  assert.equal(early.orders[0].whitePeace, true);

  // Now take something, and the demand should name exactly that.
  state.provinces['KP-04'].controller = 'KR';
  const later = parse(state, '북한과 강화하라');
  assert.equal(later.orders[0].whitePeace, false);
  assert.deepEqual(later.orders[0].annex, ['KP-04']);
});

test('질문에는 답만 하고 턴을 쓰지 않는다', () => {
  const state = fresh('ask');

  const about = parse(state, '북한 군사력이 어때?');
  assert.equal(about.isQuestion, true);
  assert.equal(about.orders.length, 0);
  assert.match(about.reply, /조선|병력|사단/);

  const place = parse(state, '개성 상황 알려줘');
  assert.equal(place.isQuestion, true);
  assert.match(place.reply, /개성/);
});

test('지도에서 클릭한 지역이 말하지 않은 목표를 대신한다', () => {
  const state = fresh('selection');
  resolveTurn(state, world, { KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: 't' }] });

  const result = parse(state, '공격하라', { selectedProvince: 'KP-04' });
  assert.equal(result.orders[0]?.type, 'OFFENSIVE');
  assert.equal(result.orders[0].to, 'KP-04');
});

test('알아듣지 못하면 조용히 실패하지 않고 예시를 알려준다', () => {
  const state = fresh('unknown');
  const result = parse(state, '음... 뭔가 멋진 일을 해봐');
  assert.equal(result.orders.length, 0);
  assert.ok(result.reply.length > 20, 'the player must be told what to type instead');
});

test('불가능한 지시는 이유와 함께 거부된다', () => {
  const state = fresh('impossible');
  // Not at war, so no attack is legal.
  const result = parse(state, '평양을 공격하라');
  assert.equal(result.orders.length, 0);
  assert.ok(
    result.rejected.some((r) => /전쟁 상태가 아닙니다/.test(r.reason)) ||
      /닿을 수 있는|⚠/.test(result.reply),
    `expected a usable explanation, got: ${result.reply}`,
  );

  const nuke = parse(state, '평양에 핵 공격');
  assert.equal(nuke.orders.length, 0, 'South Korea has no warheads');
});
