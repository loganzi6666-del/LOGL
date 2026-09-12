/**
 * The JSON Schema both providers are held to.
 *
 * Strict structured-output modes require every property to appear in `required`,
 * so fields that only apply to some order types are declared nullable rather
 * than optional. `stripNulls` removes them before the engine sees the order.
 */

import { ORDER_TYPES } from '../game/orders.js';
import { nullable } from '../llm/index.js';

const ORDER_PROPERTIES = {
  type: { type: 'string', enum: Object.keys(ORDER_TYPES), description: '명령 종류' },
  from: nullable('string', { description: '출발 지역 코드 (예: KR-01)' }),
  to: nullable('string', { description: '목표 지역 코드' }),
  province: nullable('string', { description: '대상 지역 코드' }),
  target: nullable('string', {
    description: "대상 국가 코드(KP 등). INVEST에서는 'economy' 또는 'research'.",
  }),
  commit: nullable('number', { description: '투입 사단 수' }),
  divisions: nullable('number', { description: '편성할 사단 수' }),
  amount: nullable('number', { description: '금액 (십억 USD)' }),
  value: nullable('number', { description: 'GDP 대비 국방예산 비율 (0.002~0.30)' }),
  annex: nullable('array', { items: { type: 'string' }, description: '할양 요구 지역 코드 목록' }),
  reparations: nullable('number', { description: '배상금 (십억 USD)' }),
  whitePeace: nullable('boolean', { description: '영토 변경 없는 백지 강화' }),
  casusBelli: nullable('string', { description: '선전포고 명분' }),
  text: nullable('string', { description: '성명 내용' }),
};

export const orderSchema = {
  type: 'object',
  properties: ORDER_PROPERTIES,
  required: Object.keys(ORDER_PROPERTIES),
  additionalProperties: false,
};

/** What an AI nation returns each turn. */
export const nationDecisionSchema = {
  type: 'object',
  properties: {
    assessment: {
      type: 'string',
      description: '현재 정세에 대한 우리 정부의 판단 (2~3문장, 한국어)',
    },
    intent: {
      type: 'string',
      description: '이번 달의 전략 목표 한 문장',
    },
    orders: {
      type: 'array',
      items: orderSchema,
      description: '이번 달에 실행할 명령. 취할 행동이 없으면 빈 배열.',
    },
  },
  required: ['assessment', 'intent', 'orders'],
  additionalProperties: false,
};

/** What the arbiter returns when it reads the player's instruction. */
export const arbiterSchema = {
  type: 'object',
  properties: {
    understanding: {
      type: 'string',
      description: '플레이어 지시를 어떻게 이해했는지 한 문장 요약',
    },
    reply: {
      type: 'string',
      description:
        '플레이어에게 보여줄 답변. 질문이었다면 답을, 명령이었다면 어떻게 집행하는지 설명. 한국어.',
    },
    isQuestion: {
      type: 'boolean',
      description: '명령이 아니라 질문·상담이면 true (이 경우 orders는 비워 둡니다)',
    },
    orders: { type: 'array', items: orderSchema },
  },
  required: ['understanding', 'reply', 'isQuestion', 'orders'],
  additionalProperties: false,
};

/** The turn's news bulletin. */
export const narratorSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '이번 달을 요약하는 헤드라인 한 줄' },
    report: {
      type: 'string',
      description:
        '이번 달 세계 정세 브리핑. 3~6문단, 한국어. 실제 일어난 사건만 다루고 새로운 사실을 지어내지 마십시오.',
    },
    advisories: {
      type: 'array',
      items: { type: 'string' },
      description: '플레이어가 다음 달에 고려할 만한 사항 2~4개',
    },
  },
  required: ['headline', 'report', 'advisories'],
  additionalProperties: false,
};
