/**
 * Turns the game state into the briefing a nation's leadership reads before
 * deciding what to do.
 *
 * Everything here is derived from the state, so the model is never told anything
 * the engine cannot verify — and it is told the province codes it needs, so its
 * orders can name real places rather than guessing.
 */

import { MILITARY, TROOPS_PER_DIVISION } from '../game/rules.js';
import { ORDER_TYPES } from '../game/orders.js';
import { areAllied, areAtWar, getRelation, provincesOf } from '../game/state.js';
import { armiesIn, garrisonIn } from '../game/military.js';
import { findWar, scoreFor } from '../game/diplomacy.js';

const money = (value) => `$${Number(value ?? 0).toFixed(1)}B`;
const millions = (value) => `${(value / 1e6).toFixed(1)}M`;
const pct = (value) => `${Math.round(value)}%`;

function relationLabel(value) {
  if (value >= 70) return '긴밀';
  if (value >= 30) return '우호';
  if (value > -20) return '중립';
  if (value > -60) return '냉랭';
  return '적대';
}

/** The nation's own position: economy, army, politics, standing agreements. */
export function selfBriefing(state, world, iso2) {
  const nation = state.nations[iso2];
  const lines = [];

  lines.push(`## 우리나라: ${nation.nameKo} (${iso2})`);
  lines.push(`정부형태: ${nation.government}`);
  if (nation.doctrine) lines.push(`국가전략: ${nation.doctrine}`);
  lines.push(
    `인구 ${millions(nation.population)} | GDP ${money(nation.gdp)} | 국고 ${money(nation.treasury)} ` +
      `(월 수입 ${money(nation.income)}, 월 지출 ${money(nation.expenses)})`,
  );
  lines.push(
    `국방예산 비중 GDP의 ${(nation.defenceShare * 100).toFixed(2)}% | ` +
      `사단 1개 유지비 ${money(nation.upkeepPerDivision)}/월 | 신규 편성비 ${money(nation.upkeepPerDivision * 30)}/개`,
  );
  lines.push(
    `병력 ${nation.divisions.toFixed(1)}개 사단 (${nation.troops.toLocaleString('ko-KR')}명) | ` +
      `장비·훈련 수준 ${nation.quality.toFixed(2)} | 군사기술 ${nation.tech}/10 | ` +
      `동원 가능 인력 ${nation.manpower.toLocaleString('ko-KR')}명`,
  );
  lines.push(
    `안정도 ${Math.round(nation.stability)}/100 | 전쟁지지 ${Math.round(nation.warSupport)}/100 | ` +
      `전쟁피로 ${Math.round(nation.warExhaustion)}/100 | 핵탄두 ${nation.nukes}발 | 보유 주 ${nation.controlledProvinces}개`,
  );

  const allies = nation.allies.map((x) => state.nations[x]?.nameKo ?? x);
  if (allies.length) lines.push(`동맹: ${allies.join(', ')}`);
  if (nation.atWarWith.length) {
    lines.push(`교전 중: ${nation.atWarWith.map((x) => state.nations[x]?.nameKo ?? x).join(', ')}`);
  }
  const truces = Object.entries(nation.truces ?? {})
    .filter(([, until]) => until > state.meta.turn)
    .map(([who, until]) => `${state.nations[who]?.nameKo ?? who}(${until - state.meta.turn}턴)`);
  if (truces.length) lines.push(`정전 협정 중(선전포고 불가): ${truces.join(', ')}`);
  if (nation.occupiedByEnemy > 0) lines.push(`⚠ 우리 영토 ${nation.occupiedByEnemy}개 주가 적에게 점령당했습니다.`);

  return lines.join('\n');
}

/** Where this nation's forces are, biggest concentrations first. */
export function forceBriefing(state, world, iso2, limit = 14) {
  const armies = Object.values(state.armies)
    .filter((army) => army.owner === iso2)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
  if (!armies.length) return '## 우리 군 배치\n(배치된 병력 없음)';

  const lines = ['## 우리 군 배치 (사단 수, 사기, 보급, 참호)'];
  for (const army of armies) {
    const province = world.province(army.province);
    lines.push(
      `- ${army.province} ${province.name}: ${army.strength.toFixed(1)}사단, ` +
        `사기 ${pct(army.morale * 100)}, 보급 ${pct(army.supply * 100)}, 참호 ${army.entrenchment}` +
        (army.supply < 0.6 ? ' ⚠보급 위험' : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Every place this nation could actually attack this turn, with the strength it
 * would be attacking into. Without this the model guesses at adjacency; with it,
 * its orders are legal by construction.
 */
export function frontBriefing(state, world, iso2, limit = 18) {
  if (!state.nations[iso2].atWarWith.length) return '';

  const options = new Map();
  for (const id of provincesOf(state, iso2, { controlled: true })) {
    const available = garrisonIn(state, id, iso2);
    if (available < 0.1) continue;

    for (const neighbour of world.neighbours(id)) {
      const runtime = state.provinces[neighbour];
      if (!runtime || !areAtWar(state, iso2, runtime.controller)) continue;
      let entry = options.get(neighbour);
      if (!entry) {
        entry = { id: neighbour, from: [], amphibious: false };
        options.set(neighbour, entry);
      }
      entry.from.push({ id, name: world.province(id).name, available });
    }
  }

  // Amphibious options: reachable coastlines held by an enemy.
  for (const id of provincesOf(state, iso2, { controlled: true })) {
    const origin = world.province(id);
    if (!origin.coastal) continue;
    const available = garrisonIn(state, id, iso2);
    if (available < 1) continue;
    for (const { id: reach, distance } of world.withinSeaRange(id, MILITARY.NAVAL_RANGE_KM)) {
      const runtime = state.provinces[reach];
      if (!runtime || !areAtWar(state, iso2, runtime.controller)) continue;
      if (options.has(reach)) continue;
      options.set(reach, {
        id: reach,
        from: [{ id, name: origin.name, available, distance: Math.round(distance) }],
        amphibious: true,
      });
    }
  }

  if (!options.size) return '';

  const lines = ['## 공격 가능 지역 (여기 적힌 경로로만 진격 명령이 유효합니다)'];
  const sorted = [...options.values()].sort((a, b) => {
    const pa = state.provinces[a.id].frontProgress;
    const pb = state.provinces[b.id].frontProgress;
    return pb - pa;
  });

  for (const option of sorted.slice(0, limit)) {
    const runtime = state.provinces[option.id];
    const province = world.province(option.id);
    const defenders = armiesIn(state, option.id, runtime.controller).reduce(
      (sum, army) => sum + army.strength,
      0,
    );
    const owner = state.nations[runtime.controller]?.nameKo ?? runtime.controller;
    lines.push(
      `- ${option.id} ${province.name} (${owner} 통제): 수비 ${defenders.toFixed(1)}사단, ` +
        `요새 ${runtime.fortLevel}, 인구 ${millions(province.population)}, 전선 진척 ${Math.round(runtime.frontProgress)}%`,
    );
    for (const source of option.from.slice(0, 3)) {
      lines.push(
        option.amphibious
          ? `    · 상륙: ${source.id} ${source.name}에서 ${source.distance}km (가용 ${source.available.toFixed(1)}사단) — NAVAL_INVASION`
          : `    · 진격: ${source.id} ${source.name}에서 (가용 ${source.available.toFixed(1)}사단) — OFFENSIVE`,
      );
    }
  }
  return lines.join('\n');
}

/** Who we are at war with, and who is winning. */
export function warBriefing(state, world, iso2) {
  const wars = state.wars.filter(
    (war) => war.attackers.includes(iso2) || war.defenders.includes(iso2),
  );
  if (!wars.length) return '';

  const lines = ['## 진행 중인 전쟁'];
  for (const war of wars) {
    const ours = war.attackers.includes(iso2) ? war.attackers : war.defenders;
    const theirs = war.attackers.includes(iso2) ? war.defenders : war.attackers;
    const score = scoreFor(war, iso2);
    const name = (list) => list.map((x) => state.nations[x]?.nameKo ?? x).join('+');
    lines.push(
      `- ${name(ours)} vs ${name(theirs)} | ${state.meta.turn - war.startTurn}개월째 | ` +
        `전쟁점수 ${score > 0 ? '+' : ''}${score.toFixed(0)} (${score > 25 ? '우세' : score < -25 ? '열세' : '교착'})`,
    );

    // What we hold of theirs, and what they hold of ours — the currency of peace.
    const weHold = [];
    const theyHold = [];
    for (const [id, province] of Object.entries(state.provinces)) {
      if (theirs.includes(province.owner) && ours.includes(province.controller)) weHold.push(id);
      else if (ours.includes(province.owner) && theirs.includes(province.controller)) theyHold.push(id);
    }
    if (weHold.length) {
      lines.push(
        `    우리가 점령 중(강화 시 할양 요구 가능): ${weHold
          .slice(0, 20)
          .map((id) => `${id} ${world.province(id).name}`)
          .join(', ')}${weHold.length > 20 ? ` 외 ${weHold.length - 20}개` : ''}`,
      );
    }
    if (theyHold.length) {
      lines.push(
        `    적이 점령 중: ${theyHold
          .slice(0, 20)
          .map((id) => `${id} ${world.province(id).name}`)
          .join(', ')}${theyHold.length > 20 ? ` 외 ${theyHold.length - 20}개` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

/** The neighbours and powers this nation has to reckon with. */
export function neighbourBriefing(state, world, iso2, limit = 12) {
  const nation = state.nations[iso2];
  const candidates = new Set([...nation.neighbours, ...nation.allies, ...nation.rivals, ...nation.atWarWith]);

  // Plus whichever great powers matter, so a small state still sees the weather.
  const powers = Object.values(state.nations)
    .filter((other) => other.alive && other.iso2 !== iso2)
    .sort((a, b) => b.gdp - a.gdp)
    .slice(0, 6);
  for (const power of powers) candidates.add(power.iso2);

  const rows = [...candidates]
    .map((code) => state.nations[code])
    .filter((other) => other?.alive)
    .sort((a, b) => {
      const warA = areAtWar(state, iso2, a.iso2) ? 1 : 0;
      const warB = areAtWar(state, iso2, b.iso2) ? 1 : 0;
      if (warA !== warB) return warB - warA;
      return b.gdp - a.gdp;
    })
    .slice(0, limit);

  if (!rows.length) return '';

  const lines = ['## 주요 관계국'];
  for (const other of rows) {
    const relation = getRelation(state, iso2, other.iso2);
    const tags = [];
    if (areAtWar(state, iso2, other.iso2)) tags.push('교전중');
    if (areAllied(state, iso2, other.iso2)) tags.push('동맹');
    if (nation.neighbours.includes(other.iso2)) tags.push('접경');
    if (other.nukes > 0) tags.push(`핵 ${other.nukes}발`);
    lines.push(
      `- ${other.nameKo} (${other.iso2}): 관계 ${relation.toFixed(0)} ${relationLabel(relation)} | ` +
        `GDP ${money(other.gdp)} | 병력 ${other.divisions.toFixed(0)}사단 (장비 ${other.quality.toFixed(2)}) | ` +
        `안정 ${Math.round(other.stability)}` +
        (tags.length ? ` | ${tags.join(', ')}` : ''),
    );
  }
  return lines.join('\n');
}

/** What just happened in the world, filtered to what this nation would notice. */
export function newsBriefing(state, iso2, limit = 14) {
  const lastTurn = state.meta.turn - 1;
  const relevant = state.log
    .filter((entry) => entry.turn >= lastTurn - 1)
    .filter((entry) => {
      if (entry.kind === 'rejected') return entry.nation === iso2;
      if (['war', 'peace', 'nuclear', 'collapse', 'capitulation', 'statement'].includes(entry.kind)) {
        return true; // world-shaking news reaches everyone
      }
      return entry.nation === iso2 || entry.target === iso2;
    })
    .slice(-limit);

  if (!relevant.length) return '';
  return ['## 최근 정세', ...relevant.map((entry) => `- ${entry.text}`)].join('\n');
}

/** The complete briefing one nation's AI acts on. */
export function buildNationContext(state, world, iso2, { includeFronts = true } = {}) {
  const sections = [
    `현재 시점: ${state.meta.year}년 ${state.meta.month}월 (${state.meta.turn}턴)`,
    selfBriefing(state, world, iso2),
    forceBriefing(state, world, iso2),
    includeFronts ? frontBriefing(state, world, iso2) : '',
    warBriefing(state, world, iso2),
    neighbourBriefing(state, world, iso2),
    newsBriefing(state, iso2),
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** The order vocabulary, rendered for a prompt. */
export function orderReference() {
  const lines = ['사용 가능한 명령 (type과 필드는 정확히 아래대로):'];
  for (const [type, spec] of Object.entries(ORDER_TYPES)) {
    const fields = Object.entries(spec.fields)
      .map(([key, kind]) => `${key}: ${kind}`)
      .join(', ');
    lines.push(`- ${type} { ${fields} }  — ${spec.summary}`);
  }
  return lines.join('\n');
}

export const CODE_RULES = `지역 코드는 반드시 "US-01", "KP-04" 같은 형식이며, 브리핑에 실제로 등장한 코드만 사용하십시오.
국가 코드는 ISO 3166-1 alpha-2 두 글자(KR, US, CN...)입니다. 존재하지 않는 코드를 지어내면 명령이 거부됩니다.
병력(commit)은 해당 지역의 가용 사단 수를 넘을 수 없습니다. 금액은 국고를 넘을 수 없습니다.`;

export { TROOPS_PER_DIVISION };
