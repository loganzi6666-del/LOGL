/**
 * The month's news bulletin.
 *
 * The narrator is given the events the engine actually produced and asked to
 * write them up. It is explicitly told not to add anything — every battle,
 * treaty and casualty figure in the report came out of the simulation.
 */

import { askForJson } from '../llm/index.js';
import { narratorSchema } from './schema.js';
import { selfBriefing, warBriefing } from './context.js';

const SYSTEM = `당신은 국제 정세를 다루는 통신사의 수석 기자입니다. 한 달 동안 실제로 일어난 일을 정리해 브리핑을 씁니다.

규칙:
1. 주어진 사건 목록에 없는 사실을 절대 만들어내지 마십시오. 전투 결과, 사상자 수, 조약 내용은 모두 목록에 있는 그대로만 씁니다.
2. 사건들 사이의 인과와 의미를 해석하는 것은 좋습니다. 사실을 지어내는 것과는 다릅니다.
3. 플레이어 국가의 관점에서 무엇이 중요한지 짚되, 문체는 중립적인 보도문으로 유지합니다.
4. 아무 일도 없었다면 그렇게 쓰십시오. 억지로 사건을 만들지 마십시오.
5. advisories는 브리핑에 드러난 사실에 근거한 실질적 조언이어야 합니다.
6. 전부 한국어로 씁니다.`;

const INTERESTING = new Set([
  'war', 'peace', 'capture', 'nuclear', 'collapse', 'capitulation',
  'revolt', 'diplomacy', 'statement', 'politics', 'battle',
]);

/**
 * @param {object} report the return value of `resolveTurn`
 * @returns {Promise<{headline, report, advisories}>}
 */
export async function narrateTurn(state, world, report, { playerDecision = null } = {}) {
  const player = state.meta.playerNation;

  // Rank events so the important ones survive the cut.
  const scored = report.events
    .filter((event) => event.kind !== 'rejected')
    .map((event) => {
      let weight = INTERESTING.has(event.kind) ? 10 : 1;
      if (event.nation === player || event.target === player) weight += 20;
      if (['nuclear', 'collapse', 'capitulation', 'peace', 'war'].includes(event.kind)) weight += 15;
      if (event.kind === 'capture') weight += 8;
      return { event, weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 45)
    .map(({ event }) => `- [${event.kind}] ${event.text}`);

  const territorial = report.mapChanges
    .slice(0, 30)
    .map((change) => {
      const name = world.province(change.province)?.name ?? change.province;
      const to = state.nations[change.controller]?.nameKo ?? change.controller;
      const from = state.nations[change.previousController]?.nameKo ?? change.previousController;
      return change.annexed
        ? `- ${name}: ${state.nations[change.previousOwner]?.nameKo ?? change.previousOwner} → ${state.nations[change.owner]?.nameKo ?? change.owner} (영유권 이전)`
        : `- ${name}: ${from} → ${to} (점령)`;
    });

  const sections = [
    `## ${report.date} 정세 보고 (플레이어 국가: ${state.nations[player].nameKo})`,
    scored.length ? `### 이번 달 사건\n${scored.join('\n')}` : '### 이번 달 사건\n- 특기할 사건 없음',
    territorial.length ? `### 영토 변동\n${territorial.join('\n')}` : '',
    selfBriefing(state, world, player),
    warBriefing(state, world, player),
    playerDecision ? `### 우리 정부의 이번 달 결정\n${playerDecision}` : '',
  ];

  return askForJson({
    system: SYSTEM,
    cacheable: true,
    effort: 'low',
    maxTokens: 3000,
    schema: narratorSchema,
    user: sections.filter(Boolean).join('\n\n'),
  });
}

/**
 * A plain-text fallback used when no API key is configured, so the game is
 * still playable — just without the prose.
 */
export function localSummary(state, world, report) {
  const player = state.meta.playerNation;
  const notable = report.events.filter(
    (event) => event.kind !== 'rejected' && (INTERESTING.has(event.kind) || event.nation === player),
  );
  const captures = report.mapChanges.filter((c) => !c.annexed).length;
  const annexations = report.mapChanges.filter((c) => c.annexed).length;

  const headline =
    annexations > 0
      ? `${report.date}: 영유권 ${annexations}개 주 이전`
      : captures > 0
        ? `${report.date}: 전선에서 ${captures}개 주 통제권 변동`
        : `${report.date}: 큰 변동 없음`;

  return {
    headline,
    report:
      notable.length > 0
        ? notable.slice(0, 25).map((event) => `· ${event.text}`).join('\n')
        : '이번 달에는 특기할 사건이 없었습니다.',
    advisories: [],
    offline: true,
  };
}
