/**
 * The arbiter: turns what the player typed into orders the engine will accept.
 *
 * It has no authority over outcomes. It reads the same briefing an AI nation
 * gets, translates the instruction into the order vocabulary, and hands the
 * result to the validator — which rejects anything the map does not permit and
 * says why, so the player finds out immediately rather than at end of turn.
 */

import { askForJson, stripNulls } from '../llm/index.js';
import { validateOrders } from '../game/orders.js';
import { buildNationContext, CODE_RULES, orderReference } from './context.js';
import { arbiterSchema } from './schema.js';

const SYSTEM = `당신은 한 국가 정부의 참모본부입니다. 국가원수(플레이어)의 지시를 받아 실행 가능한 명령으로 옮깁니다.

${orderReference()}

${CODE_RULES}

원칙:
1. 플레이어의 의도를 최대한 충실히 집행하십시오. 당신이 대신 판단해서 지시를 바꾸지 마십시오.
2. 지시가 여러 단계를 뜻하면 필요한 명령을 모두 만드십시오. 예를 들어 "일본을 친다"는 아직 전쟁 중이 아니라면 DECLARE_WAR 다음에 NAVAL_INVASION이 필요합니다.
3. 브리핑의 "공격 가능 지역"에 없는 경로로는 진격 명령을 만들지 마십시오. 대신 reply에 왜 불가능한지, 무엇이 필요한지 설명하십시오.
4. 지시가 명령이 아니라 질문이나 상담이면 isQuestion=true로 두고 orders는 비운 뒤, 브리핑에 있는 사실만으로 답하십시오.
5. 수치를 지정하지 않았다면 상황에 맞는 합리적인 값을 고르고 reply에 그 근거를 밝히십시오.
6. 전과를 과장하거나 결과를 예단하지 마십시오. 전투 결과는 당신이 정하지 않습니다.
7. reply는 한국어로, 참모가 원수에게 보고하듯 간결하게 씁니다.`;

/**
 * @returns {{understanding, reply, isQuestion, orders, rejected}}
 *   `orders` are validated and safe to feed to the engine; `rejected` explains
 *   the ones that were not.
 */
export async function interpretCommand(state, world, instruction) {
  const iso2 = state.meta.playerNation;
  const context = buildNationContext(state, world, iso2);

  const result = await askForJson({
    system: SYSTEM,
    cacheable: true,
    effort: 'medium',
    schema: arbiterSchema,
    user: `${context}\n\n## 국가원수의 지시\n${instruction}`,
  });

  const cleaned = stripNulls(result);
  const { accepted, rejected } = validateOrders(state, world, iso2, cleaned.orders ?? []);

  return {
    understanding: cleaned.understanding ?? '',
    reply: cleaned.reply ?? '',
    isQuestion: Boolean(cleaned.isQuestion),
    orders: accepted,
    rejected,
  };
}

/**
 * Give the arbiter one chance to fix orders the engine refused. The rejection
 * reasons are specific enough ("those provinces are not adjacent", "you hold
 * $16B") that a second attempt usually lands.
 */
export async function retryRejected(state, world, instruction, rejected) {
  if (!rejected.length) return { orders: [], rejected: [], reply: '' };
  const iso2 = state.meta.playerNation;
  const context = buildNationContext(state, world, iso2);

  const problems = rejected
    .map((entry) => `- ${JSON.stringify(entry.order)}\n  거부 사유: ${entry.reason}`)
    .join('\n');

  const result = await askForJson({
    system: SYSTEM,
    cacheable: true,
    effort: 'medium',
    schema: arbiterSchema,
    user:
      `${context}\n\n## 국가원수의 지시\n${instruction}\n\n` +
      `## 아래 명령이 거부되었습니다. 사유를 보고 실행 가능하게 고치거나, 불가능하면 orders를 비우고 reply로 설명하십시오.\n${problems}`,
  });

  const cleaned = stripNulls(result);
  const { accepted, rejected: stillBad } = validateOrders(state, world, iso2, cleaned.orders ?? []);
  return { orders: accepted, rejected: stillBad, reply: cleaned.reply ?? '' };
}
