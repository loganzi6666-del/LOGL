/**
 * Exercises the whole language-model pipeline with a stub provider, so the path
 * from "a sentence the player typed" to "a border moved" is covered without an
 * API key or a network call.
 *
 * What matters here is not that the model says something sensible — it is that
 * whatever it says, only legal orders reach the engine, and illegal ones come
 * back with a reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setProvider } from '../src/llm/index.js';
import { loadWorld } from '../src/game/world.js';
import { newGame, recomputeAll, areAtWar } from '../src/game/state.js';
import { Rng } from '../src/game/rng.js';
import { resolveTurn } from '../src/game/engine.js';
import { interpretCommand } from '../src/ai/arbiter.js';
import { planAiTurn } from '../src/ai/nation.js';
import { narrateTurn } from '../src/ai/narrator.js';

const world = loadWorld();

function fresh(seed = 'llm-test') {
  const state = newGame({ playerNation: 'KR', seed });
  recomputeAll(state, world);
  return state;
}

/** A provider that returns whatever the test tells it to, and records the prompts. */
function stubProvider(replies) {
  const calls = [];
  let index = 0;
  const next = (options) => {
    calls.push(options);
    const reply = typeof replies === 'function' ? replies(options, index) : replies[index] ?? replies.at(-1);
    index += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return {
    calls,
    name: 'stub',
    model: 'stub',
    async json(options) {
      return next(options);
    },
    async text(options) {
      return String(next(options));
    },
  };
}

test.afterEach(() => setProvider(null));

test('a natural-language order becomes a legal order, and the map moves', async () => {
  const state = fresh('arbiter');

  setProvider(
    stubProvider([
      {
        understanding: '북한에 선전포고하고 개성으로 진격하라는 지시',
        reply: '선전포고 후 개성 방면으로 공세를 준비하겠습니다.',
        isQuestion: false,
        orders: [
          { type: 'DECLARE_WAR', target: 'KP', casusBelli: '핵 위협 제거' },
          { type: 'RECRUIT', divisions: 2 },
        ],
      },
    ]),
  );

  const result = await interpretCommand(state, world, '북한에 선전포고하고 병력을 증강하라');
  assert.equal(result.isQuestion, false);
  assert.equal(result.orders.length, 2);
  assert.equal(result.rejected.length, 0);

  resolveTurn(state, world, { KR: result.orders });
  assert.ok(areAtWar(state, 'KR', 'KP'), 'the declaration should have taken effect');
});

test('orders the model invents are rejected with a reason, not applied', async () => {
  const state = fresh('rejection');

  setProvider(
    stubProvider([
      {
        understanding: '테스트',
        reply: '',
        isQuestion: false,
        orders: [
          // A province that does not exist.
          { type: 'OFFENSIVE', from: 'KR-01', to: 'ZZ-99', commit: 5 },
          // Attacking a nation we are not at war with.
          { type: 'OFFENSIVE', from: 'KR-01', to: 'KP-04', commit: 5 },
          // Spending money the treasury does not hold.
          { type: 'INVEST', target: 'economy', amount: 999999 },
          // Nuclear weapons South Korea does not have.
          { type: 'NUCLEAR_STRIKE', province: 'KP-01' },
        ],
      },
      // The corrective second pass gives up rather than inventing more.
      { understanding: '', reply: '해당 작전은 불가능합니다.', isQuestion: false, orders: [] },
    ]),
  );

  const result = await interpretCommand(state, world, '평양을 핵으로 공격하라');
  assert.equal(result.orders.length, 0, 'nothing illegal should get through');
  assert.equal(result.rejected.length, 4);
  for (const refusal of result.rejected) {
    assert.ok(refusal.reason.length > 5, 'every refusal explains itself');
  }

  // And the world is untouched by the attempt.
  assert.equal(areAtWar(state, 'KR', 'KP'), false);
  assert.equal(state.provinces['KP-01'].devastation, 0);
});

test('a question is answered without spending the turn', async () => {
  const state = fresh('question');
  setProvider(
    stubProvider([
      {
        understanding: '북한 군사력에 대한 질문',
        reply: '북한은 85.3개 사단을 보유하고 있으나 장비 수준은 우리의 절반 수준입니다.',
        isQuestion: true,
        orders: [],
      },
    ]),
  );

  const result = await interpretCommand(state, world, '북한 군사력이 우리보다 강한가?');
  assert.equal(result.isQuestion, true);
  assert.equal(result.orders.length, 0);
  assert.match(result.reply, /북한/);
});

test('AI nations act through the same validator as the player', async () => {
  const state = fresh('nations');
  const rng = new Rng(3);

  setProvider(
    stubProvider((options) => ({
      assessment: '주변 정세는 안정적입니다.',
      intent: '경제 기반을 다진다.',
      // One legal order and one impossible one, every time.
      orders: [
        { type: 'INVEST', target: 'economy', amount: 1 },
        { type: 'OFFENSIVE', from: 'XX-01', to: 'YY-02', commit: 99 },
      ],
    })),
  );

  const { orders, decisions } = await planAiTurn(state, world, rng, { useLlm: true });
  assert.ok(decisions.length > 0, 'some nations should have thought');

  for (const decision of decisions) {
    assert.equal(decision.source, 'llm');
    assert.ok(decision.rejected.length >= 1, 'the impossible order should have been caught');
    for (const order of decision.orders) {
      assert.notEqual(order.type, 'OFFENSIVE', 'no invented attack may survive validation');
    }
  }

  // The turn still resolves cleanly with those orders in it.
  const report = resolveTurn(state, world, orders);
  assert.ok(Array.isArray(report.events));
});

test('a failing model does not stall the world', async () => {
  const state = fresh('fallback');
  const rng = new Rng(5);

  setProvider(stubProvider(() => new Error('429 rate limit')));

  const { decisions } = await planAiTurn(state, world, rng, { useLlm: true });
  assert.ok(decisions.length > 0);
  for (const decision of decisions) {
    assert.equal(decision.source, 'heuristic', 'nations fall back to rules');
    assert.match(decision.error, /rate limit/);
  }
});

test('the narrator is given only events that actually happened', async () => {
  const state = fresh('narrator');
  const report = resolveTurn(state, world, {
    KR: [{ type: 'DECLARE_WAR', target: 'KP', casusBelli: '테스트' }],
  });

  const provider = stubProvider([
    { headline: '한반도에 전운', report: '…', advisories: ['전선을 정비하십시오.'] },
  ]);
  setProvider(provider);

  const narration = await narrateTurn(state, world, report, { playerDecision: '선전포고' });
  assert.equal(narration.headline, '한반도에 전운');

  // The prompt must carry the engine's own events, and nothing invented.
  const prompt = provider.calls[0].user;
  assert.match(prompt, /선전포고/);
  assert.match(prompt, /## 2025년 2월 정세 보고|## 2025년/);
  assert.match(provider.calls[0].system, /절대 만들어내지 마십시오/);
});
