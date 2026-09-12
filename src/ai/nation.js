/**
 * AI nations.
 *
 * A handful of nations each month get a full language-model turn: they read
 * their own briefing and decide what to do in their own national interest. The
 * rest run on rules. Which nations get the model is chosen by relevance — who is
 * at war, who borders the player, who is big enough to matter — so the countries
 * the player can actually see behave like they have a mind behind them.
 */

import { askForJson, mapWithConcurrency, stripNulls } from '../llm/index.js';
import { config } from '../config.js';
import { GREAT_POWERS, areAtWar, getRelation } from '../game/state.js';
import { validateOrders } from '../game/orders.js';
import { buildNationContext, CODE_RULES, orderReference } from './context.js';
import { nationDecisionSchema } from './schema.js';
import { heuristicOrders } from './heuristic.js';

const SYSTEM = `당신은 한 주권국가의 최고 의사결정 기구입니다. 오직 그 나라의 국익만을 기준으로 판단합니다.

${orderReference()}

${CODE_RULES}

원칙:
1. 브리핑에 주어진 "국가전략"이 당신의 세계관입니다. 그 나라의 지정학적 처지, 역사적 이해관계, 국내 정치 제약에 맞게 행동하십시오.
2. 국력을 넘어서는 행동을 하지 마십시오. 국고, 병력, 인력, 동맹 관계가 실제 제약입니다.
3. 전쟁은 비용이 큽니다. 승산과 목적이 분명할 때만 시작하고, 불리해지면 강화를 택하십시오.
4. 도덕이 아니라 이익으로 판단하되, 국제적 평판과 동맹의 신뢰도 국익의 일부입니다.
5. 아무것도 하지 않는 것도 정당한 선택입니다. 할 일이 없으면 orders를 비우십시오.
6. 한 달(1턴)에 할 수 있는 일만 명령하십시오. 보통 1~4개면 충분합니다.
7. assessment와 intent는 한국어로, 그 나라 정부의 목소리로 씁니다.`;

/**
 * Rank nations by how much their decisions matter to this game right now.
 * Whoever is shooting at the player, or could be next, thinks first.
 */
export function selectThinkingNations(state, world, limit = config.thinkingNations) {
  const player = state.meta.playerNation;
  const playerNation = state.nations[player];
  const scores = new Map();

  const bump = (iso2, amount) => {
    if (!iso2 || iso2 === player) return;
    const nation = state.nations[iso2];
    if (!nation?.alive) return;
    scores.set(iso2, (scores.get(iso2) ?? 0) + amount);
  };

  for (const nation of Object.values(state.nations)) {
    if (!nation.alive || nation.iso2 === player) continue;

    // Economic weight, on a log scale so the top ten do not crowd out everyone.
    bump(nation.iso2, Math.log10(Math.max(1, nation.gdp)) * 6);
    if (GREAT_POWERS.includes(nation.iso2)) bump(nation.iso2, 18);

    // Anyone in a war is making decisions that change the map.
    if (nation.atWarWith.length) bump(nation.iso2, 30);
  }

  // Everything touching the player matters most.
  for (const enemy of playerNation.atWarWith) bump(enemy, 200);
  for (const ally of playerNation.allies) bump(ally, 60);
  for (const neighbour of playerNation.neighbours) bump(neighbour, 70);
  for (const rival of playerNation.rivals) bump(rival, 50);

  // Anyone fighting one of our allies, or fighting alongside our enemy.
  for (const enemy of playerNation.atWarWith) {
    for (const cobelligerent of state.nations[enemy]?.atWarWith ?? []) bump(cobelligerent, 40);
  }
  for (const ally of playerNation.allies) {
    for (const enemy of state.nations[ally]?.atWarWith ?? []) bump(enemy, 45);
  }

  // Whoever the player has been dealing with lately.
  for (const entry of state.log.slice(-40)) {
    if (entry.nation === player) bump(entry.target, 35);
    if (entry.target === player) bump(entry.nation, 35);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([iso2]) => iso2);
}

/** One nation's language-model turn. Falls back to the rules if the call fails. */
async function thinkFor(state, world, iso2, rng) {
  const context = buildNationContext(state, world, iso2);

  try {
    const result = await askForJson({
      system: SYSTEM,
      cacheable: true,
      effort: 'low',
      schema: nationDecisionSchema,
      maxTokens: 3000,
      user: context,
    });

    const cleaned = stripNulls(result);
    const { accepted, rejected } = validateOrders(state, world, iso2, cleaned.orders ?? []);
    return {
      iso2,
      source: 'llm',
      assessment: cleaned.assessment ?? '',
      intent: cleaned.intent ?? '',
      orders: accepted,
      rejected,
    };
  } catch (error) {
    // A rate limit or a refusal must not stall the world: fall back to rules.
    return {
      iso2,
      source: 'heuristic',
      error: String(error?.message ?? error),
      orders: validateOrders(state, world, iso2, heuristicOrders(state, world, iso2, rng)).accepted,
      rejected: [],
    };
  }
}

/**
 * Decide every AI nation's month.
 *
 * @returns {{orders: object, decisions: object[]}} orders keyed by nation code
 */
export async function planAiTurn(state, world, rng, { useLlm = true } = {}) {
  const player = state.meta.playerNation;
  const thinkers = useLlm ? selectThinkingNations(state, world) : [];
  const thinkerSet = new Set(thinkers);

  const decisions = await mapWithConcurrency(thinkers, config.concurrency, (iso2) =>
    thinkFor(state, world, iso2, rng),
  );

  const orders = {};
  for (const decision of decisions) {
    if (decision.orders.length) orders[decision.iso2] = decision.orders;
  }

  // Everyone else runs on rules.
  for (const nation of Object.values(state.nations)) {
    if (!nation.alive || nation.iso2 === player || thinkerSet.has(nation.iso2)) continue;
    const raw = heuristicOrders(state, world, nation.iso2, rng);
    if (!raw.length) continue;
    const { accepted } = validateOrders(state, world, nation.iso2, raw);
    if (accepted.length) orders[nation.iso2] = accepted;
  }

  return { orders, decisions };
}
