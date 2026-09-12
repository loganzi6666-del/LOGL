/**
 * The order vocabulary — the contract between the language model and the engine.
 *
 * The model may only ever produce these shapes, and every one of them is checked
 * against the actual state before it runs. If a nation orders an attack across
 * an ocean it cannot cross, or spends money it does not have, the order is
 * rejected with a reason that goes back to whoever issued it. Nothing the model
 * says can move a border by itself.
 */

import { MILITARY } from './rules.js';
import { armiesIn, garrisonIn } from './military.js';
import { areAllied, areAtWar, getRelation } from './state.js';

export const ORDER_TYPES = {
  OFFENSIVE: {
    summary: '인접한 적 통제 지역으로 지상 공세를 개시한다.',
    fields: { from: 'province', to: 'province', commit: 'number(사단 수)' },
  },
  NAVAL_INVASION: {
    summary: `해안 지역에서 ${MILITARY.NAVAL_RANGE_KM}km 이내의 적 해안 지역에 상륙한다.`,
    fields: { from: 'province', to: 'province', commit: 'number(사단 수)' },
  },
  MOVE: {
    summary: '아군 통제 지역 사이로 병력을 이동시킨다.',
    fields: { from: 'province', to: 'province', commit: 'number(사단 수)' },
  },
  RECRUIT: {
    summary: '신규 사단을 편성한다. 예산과 인력, 동원 속도의 제약을 받는다.',
    fields: { divisions: 'number' },
  },
  FORTIFY: {
    summary: '지역의 요새 수준을 올린다.',
    fields: { province: 'province', amount: 'number(십억 USD)' },
  },
  INVEST: {
    summary: '경제·기술에 투자한다.',
    fields: { target: "'economy' | 'research'", amount: 'number(십억 USD)' },
  },
  SET_DEFENCE_SHARE: {
    summary: 'GDP 대비 국방·외교 예산 비율을 조정한다. 급격히 올리면 안정도가 떨어진다.',
    fields: { value: 'number(0.002 ~ 0.30)' },
  },
  DECLARE_WAR: {
    summary: '선전포고한다. 정전 중인 상대에게는 불가능하다.',
    fields: { target: 'nation', casusBelli: 'string(명분)' },
  },
  PROPOSE_PEACE: {
    summary: '강화를 제안한다. 할양 요구는 현재 점령 중인 지역만 가능하다.',
    fields: {
      target: 'nation',
      annex: 'province[]',
      reparations: 'number(십억 USD)',
      whitePeace: 'boolean',
    },
  },
  FORM_ALLIANCE: {
    summary: '동맹을 제안한다. 관계가 충분히 좋아야 수락된다.',
    fields: { target: 'nation' },
  },
  BREAK_ALLIANCE: { summary: '동맹을 파기한다.', fields: { target: 'nation' } },
  IMPROVE_RELATIONS: {
    summary: '외교 자원을 써서 관계를 개선한다.',
    fields: { target: 'nation', amount: 'number(십억 USD)' },
  },
  SANCTION: {
    summary: '경제 제재를 가한다. 상대 경제에 타격을 주지만 자국도 손해를 본다.',
    fields: { target: 'nation' },
  },
  MILITARY_AID: {
    summary: '다른 나라에 군사 원조를 보낸다.',
    fields: { target: 'nation', amount: 'number(십억 USD)' },
  },
  NUCLEAR_STRIKE: {
    summary: '핵무기를 사용한다. 되돌릴 수 없으며 전 세계가 등을 돌린다.',
    fields: { province: 'province' },
  },
  STATEMENT: {
    summary: '기계적 효과가 없는 공식 성명. 다른 나라 AI가 읽는다.',
    fields: { text: 'string' },
  },
};

const asNumber = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
};

function fail(reason) {
  return { ok: false, reason };
}

/**
 * Check one order against the world as it actually is.
 * Returns `{ ok, reason, order }` with a normalised order on success.
 */
export function validateOrder(state, world, iso2, raw) {
  const nation = state.nations[iso2];
  if (!nation?.alive) return fail('존재하지 않거나 이미 멸망한 국가입니다.');
  if (!raw || typeof raw !== 'object') return fail('명령 형식이 올바르지 않습니다.');

  const type = String(raw.type ?? '').toUpperCase();
  if (!ORDER_TYPES[type]) return fail(`알 수 없는 명령입니다: ${raw.type}`);

  const order = { type, issuer: iso2 };

  const requireOwnProvince = (id, label) => {
    const runtime = state.provinces[id];
    if (!runtime) return `${label}: 존재하지 않는 지역 코드입니다 (${id}).`;
    if (runtime.controller !== iso2) {
      return `${label}: ${world.province(id).name}은(는) 우리가 통제하는 지역이 아닙니다.`;
    }
    return null;
  };

  switch (type) {
    case 'OFFENSIVE':
    case 'NAVAL_INVASION':
    case 'MOVE': {
      const from = String(raw.from ?? '');
      const to = String(raw.to ?? '');
      const problem = requireOwnProvince(from, '출발지');
      if (problem) return fail(problem);
      const targetRuntime = state.provinces[to];
      if (!targetRuntime) return fail(`목표: 존재하지 않는 지역 코드입니다 (${to}).`);

      const commit = asNumber(raw.commit);
      const available = garrisonIn(state, from, iso2);
      if (available <= 0.05) {
        return fail(`${world.province(from).name}에 투입할 수 있는 병력이 없습니다.`);
      }
      const actual = commit === null ? available : Math.min(commit, available);
      if (actual <= 0.05) {
        return fail(
          `${world.province(from).name}의 가용 병력은 ${available.toFixed(1)}개 사단뿐입니다.`,
        );
      }

      if (type === 'MOVE') {
        if (!world.neighbours(from).includes(to)) {
          return fail(`${world.province(from).name}과(와) ${world.province(to).name}은(는) 인접하지 않습니다.`);
        }
        const controller = targetRuntime.controller;
        if (controller !== iso2 && !areAllied(state, iso2, controller)) {
          return fail(`${world.province(to).name}은(는) 아군 지역이 아닙니다. 공세 명령을 사용하세요.`);
        }
      } else {
        const defender = targetRuntime.controller;
        if (defender === iso2) return fail('자국 통제 지역을 공격할 수 없습니다.');
        if (!areAtWar(state, iso2, defender)) {
          return fail(
            `${state.nations[defender]?.nameKo ?? defender}과(와) 전쟁 상태가 아닙니다. 먼저 선전포고해야 합니다.`,
          );
        }
        if (type === 'OFFENSIVE' && !world.neighbours(from).includes(to)) {
          return fail(
            `${world.province(from).name}에서 ${world.province(to).name}으로 직접 진격할 수 없습니다. 인접하지 않습니다.`,
          );
        }
        if (type === 'NAVAL_INVASION') {
          const origin = world.province(from);
          const destination = world.province(to);
          if (!origin.coastal || !destination.coastal) {
            return fail('상륙작전은 양쪽 모두 해안 지역이어야 합니다.');
          }
          const distance = world.distance(from, to);
          if (distance > MILITARY.NAVAL_RANGE_KM) {
            return fail(
              `상륙 거리 ${Math.round(distance)}km는 작전 반경 ${MILITARY.NAVAL_RANGE_KM}km를 넘습니다.`,
            );
          }
          order.distance = Math.round(distance);
        }
      }

      order.from = from;
      order.to = to;
      order.commit = Number(actual.toFixed(2));
      return { ok: true, order };
    }

    case 'RECRUIT': {
      const divisions = asNumber(raw.divisions);
      if (!(divisions > 0)) return fail('편성할 사단 수를 지정해야 합니다.');
      order.divisions = divisions;
      return { ok: true, order };
    }

    case 'FORTIFY': {
      const id = String(raw.province ?? '');
      const problem = requireOwnProvince(id, '요새화');
      if (problem) return fail(problem);
      if (state.provinces[id].fortLevel >= 5) {
        return fail(`${world.province(id).name}은(는) 이미 최대 요새 수준입니다.`);
      }
      order.province = id;
      order.amount = Math.max(0, asNumber(raw.amount) ?? nation.treasury * 0.1);
      return { ok: true, order };
    }

    case 'INVEST': {
      const target = String(raw.target ?? 'economy');
      if (!['economy', 'infrastructure', 'research'].includes(target)) {
        return fail(`투자 항목이 올바르지 않습니다: ${target}`);
      }
      const amount = asNumber(raw.amount);
      if (!(amount > 0)) return fail('투자 금액을 지정해야 합니다.');
      if (amount > nation.treasury) {
        return fail(`국고가 부족합니다. 보유 ${nation.treasury.toFixed(1)}B USD.`);
      }
      order.target = target;
      order.amount = amount;
      return { ok: true, order };
    }

    case 'SET_DEFENCE_SHARE': {
      const value = asNumber(raw.value);
      if (!(value > 0)) return fail('예산 비율을 지정해야 합니다.');
      if (value > 0.3) return fail('GDP의 30%를 넘는 국방예산은 편성할 수 없습니다.');
      order.value = Math.max(0.002, value);
      return { ok: true, order };
    }

    case 'DECLARE_WAR': {
      const target = String(raw.target ?? '').toUpperCase();
      if (!state.nations[target]?.alive) return fail(`알 수 없는 국가입니다: ${raw.target}`);
      if (target === iso2) return fail('자국에 선전포고할 수 없습니다.');
      if (areAtWar(state, iso2, target)) {
        return fail(`${state.nations[target].nameKo}과(와)는 이미 전쟁 중입니다.`);
      }
      const truce = nation.truces?.[target];
      if (truce && truce > state.meta.turn) {
        return fail(
          `${state.nations[target].nameKo}과(와)의 정전 협정이 ${truce - state.meta.turn}턴 남아 있습니다.`,
        );
      }
      order.target = target;
      order.casusBelli = String(raw.casusBelli ?? '').slice(0, 300) || '명분 없음';
      return { ok: true, order };
    }

    case 'PROPOSE_PEACE': {
      const target = String(raw.target ?? '').toUpperCase();
      if (!areAtWar(state, iso2, target)) {
        return fail(`${state.nations[target]?.nameKo ?? target}과(와) 전쟁 중이 아닙니다.`);
      }
      const whitePeace = Boolean(raw.whitePeace);
      const annex = Array.isArray(raw.annex) ? raw.annex.map(String) : [];
      if (!whitePeace) {
        for (const id of annex) {
          const runtime = state.provinces[id];
          if (!runtime) return fail(`존재하지 않는 지역 코드입니다: ${id}`);
          if (runtime.controller !== iso2) {
            return fail(
              `${world.province(id).name}을(를) 점령하지 않은 상태에서는 할양을 요구할 수 없습니다.`,
            );
          }
          if (runtime.owner === iso2) {
            return fail(`${world.province(id).name}은(는) 이미 우리 영토입니다.`);
          }
        }
      }
      order.target = target;
      order.annex = whitePeace ? [] : annex;
      order.reparations = Math.max(0, asNumber(raw.reparations) ?? 0);
      order.whitePeace = whitePeace;
      return { ok: true, order };
    }

    case 'FORM_ALLIANCE':
    case 'BREAK_ALLIANCE': {
      const target = String(raw.target ?? '').toUpperCase();
      if (!state.nations[target]?.alive) return fail(`알 수 없는 국가입니다: ${raw.target}`);
      if (type === 'FORM_ALLIANCE') {
        if (areAllied(state, iso2, target)) return fail('이미 동맹 관계입니다.');
        if (areAtWar(state, iso2, target)) return fail('교전 중인 상대와는 동맹할 수 없습니다.');
      } else if (!areAllied(state, iso2, target)) {
        return fail('동맹 관계가 아닙니다.');
      }
      order.target = target;
      return { ok: true, order };
    }

    case 'IMPROVE_RELATIONS':
    case 'MILITARY_AID': {
      const target = String(raw.target ?? '').toUpperCase();
      if (!state.nations[target]?.alive) return fail(`알 수 없는 국가입니다: ${raw.target}`);
      if (target === iso2) return fail('자국을 대상으로 할 수 없습니다.');
      const amount = asNumber(raw.amount);
      if (!(amount > 0)) return fail('금액을 지정해야 합니다.');
      if (amount > nation.treasury) {
        return fail(`국고가 부족합니다. 보유 ${nation.treasury.toFixed(1)}B USD.`);
      }
      order.target = target;
      order.amount = amount;
      return { ok: true, order };
    }

    case 'SANCTION': {
      const target = String(raw.target ?? '').toUpperCase();
      if (!state.nations[target]?.alive) return fail(`알 수 없는 국가입니다: ${raw.target}`);
      order.target = target;
      return { ok: true, order };
    }

    case 'NUCLEAR_STRIKE': {
      if (!(nation.nukes > 0)) return fail('보유한 핵탄두가 없습니다.');
      const id = String(raw.province ?? '');
      const runtime = state.provinces[id];
      if (!runtime) return fail(`존재하지 않는 지역 코드입니다: ${id}`);
      if (runtime.controller === iso2) return fail('자국 통제 지역에 핵을 사용할 수 없습니다.');
      if (!areAtWar(state, iso2, runtime.controller)) {
        return fail('전쟁 중이 아닌 상대에게 핵을 사용할 수 없습니다.');
      }
      order.province = id;
      return { ok: true, order };
    }

    case 'STATEMENT': {
      order.text = String(raw.text ?? '').slice(0, 600);
      if (!order.text) return fail('성명 내용이 비어 있습니다.');
      return { ok: true, order };
    }

    default:
      return fail(`처리할 수 없는 명령입니다: ${type}`);
  }
}

/**
 * Validate a batch in the order it was written.
 *
 * Orders within one turn are not independent: the engine settles diplomacy
 * before it fights, so "declare war on the North, then take Kaesŏng" is a legal
 * pair even though the attack is illegal at the moment the batch arrives. A
 * declaration earlier in the batch is therefore in force for everything after
 * it — otherwise the most natural thing a player can say would always be half
 * refused.
 */
export function validateOrders(state, world, iso2, rawOrders) {
  const accepted = [];
  const rejected = [];
  const provisional = [];

  const openWar = (target) => {
    const us = state.nations[iso2];
    const them = state.nations[target];
    if (!us || !them || us.atWarWith.includes(target)) return;
    us.atWarWith.push(target);
    them.atWarWith.push(iso2);
    provisional.push(target);
  };

  try {
    for (const raw of rawOrders ?? []) {
      const result = validateOrder(state, world, iso2, raw);
      if (result.ok) {
        accepted.push(result.order);
        if (result.order.type === 'DECLARE_WAR') openWar(result.order.target);
      } else {
        rejected.push({ order: raw, reason: result.reason });
      }
    }
  } finally {
    // The real declaration happens in the engine, not here.
    for (const target of provisional) {
      state.nations[iso2].atWarWith = state.nations[iso2].atWarWith.filter((x) => x !== target);
      state.nations[target].atWarWith = state.nations[target].atWarWith.filter((x) => x !== iso2);
    }
  }

  return { accepted, rejected };
}
