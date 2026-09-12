/**
 * The free command parser.
 *
 * Reads a Korean instruction and turns it into orders without calling any model.
 * It understands far less than a language model does — but it costs nothing,
 * answers instantly, works offline, and covers the great majority of what a
 * player actually types.
 *
 * It returns exactly the same shape as the LLM arbiter, so the rest of the game
 * cannot tell the difference, and every order it produces still goes through the
 * engine's validator.
 */

import { MILITARY } from '../game/rules.js';
import { validateOrders } from '../game/orders.js';
import { findLandPath } from '../game/world.js';
import { areAllied, areAtWar, getRelation, provincesOf } from '../game/state.js';
import { armiesIn, garrisonIn } from '../game/military.js';
import { findWar, scoreFor } from '../game/diplomacy.js';

/** Names for nations that the data's own Korean name does not cover. */
const NATION_ALIASES = {
  북한: 'KP', 북조선: 'KP', 조선민주주의인민공화국: 'KP',
  남한: 'KR', 대한민국: 'KR', 한국: 'KR', 우리나라: null, // resolved to the player
  미합중국: 'US', 아메리카: 'US',
  잉글랜드: 'GB', 영국: 'GB', 브리튼: 'GB',
  중공: 'CN', 중화인민공화국: 'CN',
  러시아연방: 'RU', 소련: 'RU',
  일본국: 'JP', 왜국: 'JP',
  대만: 'TW', 타이완: 'TW', 중화민국: 'TW',
  독일연방공화국: 'DE', 프랑스공화국: 'FR',
  베트남전: null,
};

/**
 * Intent keywords, longest and most specific first — "선전포고" has to win over
 * the bare "포고", and "관계 개선" over "개선".
 */
const INTENTS = [
  { type: 'NUCLEAR_STRIKE', words: ['핵공격', '핵 공격', '핵무기 사용', '핵을 사용', '핵타격', '핵 타격'] },
  { type: 'DECLARE_WAR', words: ['선전포고', '전쟁을 선포', '전쟁 선포', '개전', '전쟁을 시작', '전쟁 시작'] },
  { type: 'PROPOSE_PEACE', words: ['강화 제안', '강화를 제안', '강화', '휴전', '종전', '정전', '평화 협정', '평화협정', '전쟁을 끝'] },
  { type: 'NAVAL_INVASION', words: ['상륙', '해병', '도하'] },
  { type: 'OFFENSIVE', words: ['공격', '진격', '공세', '침공', '점령', '함락', '쳐라', '치자', '밀어붙', '돌파', '탈환', '투입', '진공'] },
  { type: 'MOVE', words: ['이동', '집결', '배치', '보내', '옮겨', '이동시'] },
  { type: 'RECRUIT', words: ['증강', '징병', '모병', '편성', '병력을 늘', '군대를 늘', '병력 늘', '군비 확장', '동원'] },
  { type: 'FORTIFY', words: ['요새', '방어선', '참호', '방비'] },
  { type: 'SET_DEFENCE_SHARE', words: ['국방비', '방위비', '국방 예산', '국방예산'] },
  { type: 'INVEST', words: ['투자', '개발', '연구', '기술 향상'] },
  { type: 'FORM_ALLIANCE', words: ['동맹'] },
  { type: 'BREAK_ALLIANCE', words: ['동맹 파기', '동맹을 파기'] },
  { type: 'IMPROVE_RELATIONS', words: ['관계 개선', '관계를 개선', '친선', '수교', '화해'] },
  { type: 'SANCTION', words: ['제재'] },
  { type: 'MILITARY_AID', words: ['군사 원조', '군사원조', '무기 지원', '원조'] },
  { type: 'STATEMENT', words: ['성명', '발표', '규탄', '경고'] },
];

const QUESTION_WORDS = [
  '?', '？', '어때', '어떻', '어떤', '알려', '무엇', '뭐야', '뭔가', '얼마', '몇',
  '왜 ', '누가', '어디', '설명', '현황', '상태는', '분석', '가능한가', '있나', '인가',
  '할까', '될까', '괜찮', '보고해', '브리핑',
];

/** Words meaning "everything we have". */
const ALL_WORDS = ['전 병력', '전병력', '모든 병력', '전부', '모두', '전군', '총공격', '총공세', '전면'];

const normalise = (text) => text.replace(/\s+/g, ' ').trim();

/** Build name → code lookups, longest name first so the specific one wins. */
function buildIndex(state, world) {
  const nations = [];
  for (const nation of Object.values(state.nations)) {
    if (!nation.alive) continue;
    nations.push([nation.nameKo, nation.iso2], [nation.name.toLowerCase(), nation.iso2], [nation.iso2.toLowerCase(), nation.iso2]);
  }
  for (const [alias, iso2] of Object.entries(NATION_ALIASES)) {
    if (iso2 && state.nations[iso2]?.alive) nations.push([alias, iso2]);
  }

  const provinces = [];
  for (const province of world.provinceList) {
    if (province.nameKo) provinces.push([province.nameKo, province.id]);
    provinces.push([province.name.toLowerCase(), province.id]);
    provinces.push([province.id.toLowerCase(), province.id]);
  }

  const byLength = (a, b) => b[0].length - a[0].length;
  nations.sort(byLength);
  provinces.sort(byLength);
  return { nations, provinces };
}

/** Every place mentioned in the text, in the order they appear. */
function findMentions(text, entries) {
  const haystack = text.toLowerCase();
  const found = [];
  const claimed = [];

  for (const [name, code] of entries) {
    if (name.length < 2) continue;
    const at = haystack.indexOf(name);
    if (at < 0) continue;
    // Don't let a shorter name match inside a longer one already taken.
    if (claimed.some(([start, end]) => at >= start && at < end)) continue;
    claimed.push([at, at + name.length]);
    found.push({ code, at, name });
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.code);
}

function firstNumber(text) {
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return { value: Number(percent[1]), isPercent: true };
  const plain = text.match(/(\d+(?:\.\d+)?)/);
  return plain ? { value: Number(plain[1]), isPercent: false } : null;
}

/** The province we would launch an attack on `target` from: ours, adjacent, strongest. */
function bestStagingFor(state, world, iso2, target) {
  let best = null;
  for (const neighbour of world.neighbours(target)) {
    if (state.provinces[neighbour]?.controller !== iso2) continue;
    const strength = garrisonIn(state, neighbour, iso2);
    if (!best || strength > best.strength) best = { id: neighbour, strength };
  }
  return best;
}

/** The coastal province we would mount a landing on `target` from. */
function bestBeachheadFor(state, world, iso2, target) {
  const destination = world.province(target);
  if (!destination?.coastal) return null;
  let best = null;
  for (const id of provincesOf(state, iso2, { controlled: true })) {
    if (!world.province(id)?.coastal) continue;
    const strength = garrisonIn(state, id, iso2);
    if (strength < 0.5) continue;
    const distance = world.distance(id, target);
    if (distance > MILITARY.NAVAL_RANGE_KM) continue;
    if (!best || strength > best.strength) best = { id, strength, distance };
  }
  return best;
}

/** Answer a question from what the state already knows — no model needed. */
function answerQuestion(state, world, text, nations, provinces) {
  const me = state.nations[state.meta.playerNation];
  const lines = [];

  if (provinces.length) {
    for (const id of provinces.slice(0, 3)) {
      const geo = world.province(id);
      const live = state.provinces[id];
      const owner = state.nations[live.owner];
      const controller = state.nations[live.controller];
      const defenders = armiesIn(state, id, live.controller).reduce((s, a) => s + a.strength, 0);
      lines.push(
        `${geo.nameKo ?? geo.name}(${id}): ${owner?.nameKo ?? live.owner} 영토` +
          (live.controller !== live.owner ? `, 현재 ${controller?.nameKo ?? live.controller}이(가) 점령 중` : '') +
          `. 인구 ${(geo.population / 1e4).toFixed(0)}만, 요새 ${live.fortLevel}/5, 주둔 ${defenders.toFixed(1)}개 사단` +
          (live.frontProgress > 0 ? `, 전선 ${Math.round(live.frontProgress)}%` : ''),
      );
    }
  }

  for (const iso2 of nations.slice(0, 3)) {
    if (iso2 === me.iso2) continue;
    const other = state.nations[iso2];
    if (!other) continue;
    const relation = getRelation(state, me.iso2, iso2);
    const war = findWar(state, me.iso2, iso2);
    lines.push(
      `${other.nameKo}: GDP $${other.gdp.toFixed(0)}B, 병력 ${other.divisions.toFixed(1)}개 사단` +
        `(장비 ${other.quality.toFixed(2)}, 우리는 ${me.quality.toFixed(2)}), 안정도 ${Math.round(other.stability)}` +
        (other.nukes ? `, 핵탄두 ${other.nukes}발` : '') +
        `. 관계 ${relation.toFixed(0)}` +
        (areAtWar(state, me.iso2, iso2) ? ` — 교전 중, 전쟁점수 ${scoreFor(war, me.iso2).toFixed(0)}` : '') +
        (areAllied(state, me.iso2, iso2) ? ' — 동맹' : ''),
    );
  }

  if (!lines.length) {
    lines.push(
      `${me.nameKo}: 국고 $${me.treasury.toFixed(1)}B (월 수지 ${(me.income - me.expenses).toFixed(1)}), ` +
        `병력 ${me.divisions.toFixed(1)}개 사단, 안정도 ${Math.round(me.stability)}, 전쟁지지 ${Math.round(me.warSupport)}.`,
    );
    if (me.atWarWith.length) {
      lines.push(`교전 중: ${me.atWarWith.map((c) => state.nations[c]?.nameKo ?? c).join(', ')}`);
    } else {
      lines.push('현재 전쟁 중인 상대는 없습니다.');
    }
  }

  return lines.join('\n');
}

/**
 * Parse one instruction.
 *
 * @param {object} options
 * @param {string} [options.selectedProvince] what the player has clicked, used
 *   when the instruction says "here" or names no place at all
 */
export function parseCommand(state, world, rawText, { selectedProvince = null } = {}) {
  const me = state.meta.playerNation;
  const nation = state.nations[me];
  const text = normalise(rawText);
  const index = buildIndex(state, world);

  const mentionedNations = findMentions(text, index.nations).filter((code) => code !== me);
  const mentionedProvinces = findMentions(text, index.provinces);

  const isQuestion = QUESTION_WORDS.some((word) => text.includes(word));
  if (isQuestion) {
    return {
      understanding: '질문으로 이해했습니다.',
      reply: answerQuestion(state, world, text, mentionedNations, mentionedProvinces),
      isQuestion: true,
      orders: [],
      rejected: [],
      source: 'local',
    };
  }

  // Which intents appear, in the order they were written.
  const hits = [];
  for (const intent of INTENTS) {
    for (const word of intent.words) {
      const at = text.indexOf(word);
      if (at >= 0) {
        hits.push({ type: intent.type, at });
        break;
      }
    }
  }
  hits.sort((a, b) => a.at - b.at);

  if (!hits.length) {
    return {
      understanding: '',
      reply:
        '무슨 행동을 원하시는지 알아듣지 못했습니다. 예: "북한에 선전포고", "개성 공격", ' +
        '"3개 사단 증강", "경제에 20 투자", "일본과 관계 개선", "강화 제안".\n' +
        '지도에서 지역을 클릭하면 가능한 행동이 버튼으로도 나옵니다.',
      isQuestion: false,
      orders: [],
      rejected: [],
      source: 'local',
    };
  }

  const number = firstNumber(text);
  const wantsEverything = ALL_WORDS.some((word) => text.includes(word));
  const raw = [];
  const notes = [];

  // A place the player clicked stands in for one they did not name.
  const targetProvince = (predicate) =>
    mentionedProvinces.find(predicate) ??
    (selectedProvince && predicate(selectedProvince) ? selectedProvince : null);

  const enemyProvince = () =>
    targetProvince((id) => {
      const controller = state.provinces[id]?.controller;
      return controller && controller !== me;
    });

  const ownProvince = () => targetProvince((id) => state.provinces[id]?.controller === me);

  for (const hit of new Map(hits.map((h) => [h.type, h])).values()) {
    switch (hit.type) {
      case 'DECLARE_WAR': {
        let target = mentionedNations[0];
        if (!target) {
          const province = enemyProvince();
          target = province ? state.provinces[province].owner : null;
        }
        if (!target) {
          notes.push('어느 나라에 선전포고할지 알 수 없습니다. 나라 이름을 함께 적어 주세요.');
          break;
        }
        raw.push({
          type: 'DECLARE_WAR',
          target,
          casusBelli: `${state.nations[target]?.nameKo ?? target}에 대한 국가 안보상의 결정`,
        });
        break;
      }

      case 'OFFENSIVE':
      case 'NAVAL_INVASION': {
        let target = enemyProvince();
        // "중국을 공격" with no province named: pick their weakest province we can reach.
        if (!target && mentionedNations.length) {
          const enemy = mentionedNations[0];
          const reachable = provincesOf(state, enemy, { controlled: true })
            .map((id) => ({ id, staging: bestStagingFor(state, world, me, id) }))
            .filter((entry) => entry.staging)
            .sort((a, b) => b.staging.strength - a.staging.strength)[0];
          target = reachable?.id ?? null;
        }
        if (!target) {
          notes.push('어디를 공격할지 알 수 없습니다. 지역 이름을 적거나 지도에서 클릭해 주세요.');
          break;
        }

        const land = bestStagingFor(state, world, me, target);
        const sea = bestBeachheadFor(state, world, me, target);
        const useSea = hit.type === 'NAVAL_INVASION' ? Boolean(sea) : !land && Boolean(sea);
        const source = useSea ? sea : land;

        if (!source) {
          notes.push(
            `${world.province(target).nameKo ?? world.province(target).name}에 닿을 수 있는 우리 지역이 없습니다. ` +
              '먼저 인접 지역으로 병력을 이동시키거나, 해안에서 상륙 가능한 거리까지 접근해야 합니다.',
          );
          break;
        }

        const commit = wantsEverything || !number ? source.strength : Math.min(number.value, source.strength);
        raw.push({
          type: useSea ? 'NAVAL_INVASION' : 'OFFENSIVE',
          from: source.id,
          to: target,
          commit,
        });
        break;
      }

      case 'MOVE': {
        const destination = ownProvince() ?? mentionedProvinces[0];
        if (!destination) {
          notes.push('어디로 이동할지 알 수 없습니다.');
          break;
        }
        // Every army takes one step along the road to the destination.
        for (const army of Object.values(state.armies)) {
          if (army.owner !== me || army.province === destination) continue;
          const path = findLandPath(
            world,
            army.province,
            destination,
            (id) => state.provinces[id]?.controller === me,
          );
          if (!path || path.length < 2) continue;
          raw.push({ type: 'MOVE', from: army.province, to: path[1], commit: army.strength });
        }
        if (!raw.some((order) => order.type === 'MOVE')) {
          notes.push('이동시킬 수 있는 병력이 없거나, 아군 영토로 이어진 길이 없습니다.');
        }
        break;
      }

      case 'RECRUIT': {
        const divisions = number && !number.isPercent ? number.value : Math.max(1, nation.divisions * 0.05);
        raw.push({ type: 'RECRUIT', divisions });
        break;
      }

      case 'FORTIFY': {
        const province = ownProvince() ?? nation.capitalProvince;
        raw.push({ type: 'FORTIFY', province, amount: nation.treasury * 0.3 });
        break;
      }

      case 'INVEST': {
        const research = ['기술', '연구', '과학'].some((word) => text.includes(word));
        const amount = number && !number.isPercent ? number.value : nation.treasury * 0.4;
        raw.push({ type: 'INVEST', target: research ? 'research' : 'economy', amount });
        break;
      }

      case 'SET_DEFENCE_SHARE': {
        if (!number) {
          notes.push('국방비를 몇 %로 할지 적어 주세요. 예: "국방비를 4%로".');
          break;
        }
        raw.push({ type: 'SET_DEFENCE_SHARE', value: number.isPercent ? number.value / 100 : number.value });
        break;
      }

      case 'PROPOSE_PEACE': {
        const target = mentionedNations[0] ?? nation.atWarWith[0];
        if (!target) {
          notes.push('강화를 제안할 상대가 없습니다. 현재 전쟁 중이 아닙니다.');
          break;
        }
        // Demand what we actually hold; a white peace if we hold nothing.
        const spoils = Object.entries(state.provinces)
          .filter(([, p]) => p.controller === me && p.owner === target)
          .map(([id]) => id);
        const giveBack = ['백지', '조건 없', '조건없', '무조건'].some((word) => text.includes(word));
        raw.push(
          spoils.length && !giveBack
            ? { type: 'PROPOSE_PEACE', target, annex: spoils, reparations: 0 }
            : { type: 'PROPOSE_PEACE', target, whitePeace: true },
        );
        break;
      }

      case 'FORM_ALLIANCE':
      case 'BREAK_ALLIANCE':
      case 'SANCTION': {
        const target = mentionedNations[0];
        if (!target) {
          notes.push('상대 국가를 적어 주세요.');
          break;
        }
        raw.push({ type: hit.type, target });
        break;
      }

      case 'IMPROVE_RELATIONS':
      case 'MILITARY_AID': {
        const target = mentionedNations[0];
        if (!target) {
          notes.push('상대 국가를 적어 주세요.');
          break;
        }
        const amount = number && !number.isPercent ? number.value : Math.max(1, nation.treasury * 0.2);
        raw.push({ type: hit.type, target, amount });
        break;
      }

      case 'NUCLEAR_STRIKE': {
        const province = enemyProvince();
        if (!province) {
          notes.push('핵을 사용할 목표 지역을 지정해 주세요.');
          break;
        }
        raw.push({ type: 'NUCLEAR_STRIKE', province });
        break;
      }

      case 'STATEMENT': {
        raw.push({ type: 'STATEMENT', text: rawText.slice(0, 400) });
        break;
      }

      default:
        break;
    }
  }

  const { accepted, rejected } = validateOrders(state, world, me, raw);

  const describe = (order) => {
    const place = (id) => world.province(id)?.nameKo ?? world.province(id)?.name ?? id;
    const who = (code) => state.nations[code]?.nameKo ?? code;
    switch (order.type) {
      case 'DECLARE_WAR': return `${who(order.target)}에 선전포고`;
      case 'OFFENSIVE': return `${place(order.from)} → ${place(order.to)} 진격 (${order.commit.toFixed(1)}개 사단)`;
      case 'NAVAL_INVASION': return `${place(order.from)} → ${place(order.to)} 상륙 (${order.commit.toFixed(1)}개 사단)`;
      case 'MOVE': return `${place(order.from)} → ${place(order.to)} 이동`;
      case 'RECRUIT': return `${order.divisions.toFixed(1)}개 사단 편성`;
      case 'FORTIFY': return `${place(order.province)} 요새화`;
      case 'INVEST': return `${order.target === 'research' ? '기술' : '경제'}에 $${order.amount.toFixed(1)}B 투자`;
      case 'SET_DEFENCE_SHARE': return `국방비를 GDP의 ${(order.value * 100).toFixed(1)}%로 조정`;
      case 'PROPOSE_PEACE': return order.whitePeace ? `${who(order.target)}에 백지 강화 제안` : `${who(order.target)}에 강화 제안 (${order.annex.length}개 주 할양 요구)`;
      case 'FORM_ALLIANCE': return `${who(order.target)}에 동맹 제안`;
      case 'SANCTION': return `${who(order.target)} 제재`;
      case 'IMPROVE_RELATIONS': return `${who(order.target)}과 관계 개선 ($${order.amount.toFixed(1)}B)`;
      case 'MILITARY_AID': return `${who(order.target)}에 군사 원조 ($${order.amount.toFixed(1)}B)`;
      case 'NUCLEAR_STRIKE': return `${place(order.province)}에 핵 공격`;
      default: return order.type;
    }
  };

  const replyParts = [];
  if (accepted.length) {
    const shown = accepted.slice(0, 6).map((order) => `· ${describe(order)}`);
    if (accepted.length > 6) shown.push(`· 외 ${accepted.length - 6}건`);
    replyParts.push(shown.join('\n'));
  }
  for (const note of notes) replyParts.push(`⚠ ${note}`);
  for (const refusal of rejected) replyParts.push(`⛔ ${refusal.reason}`);
  if (!replyParts.length) replyParts.push('실행 가능한 명령을 만들지 못했습니다.');

  return {
    understanding: hits.map((hit) => hit.type).join(', '),
    reply: replyParts.join('\n'),
    isQuestion: false,
    orders: accepted,
    rejected,
    source: 'local',
  };
}
