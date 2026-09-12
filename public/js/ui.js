/**
 * Panel rendering.
 *
 * Every function here takes state and writes into the DOM. Numbers wear text
 * tokens, never a series colour; status always carries a glyph and a word beside
 * the colour, so nothing depends on hue alone.
 */

import { HUES, PLAYER_COLOUR, STATUS } from './palette.js';

const $ = (id) => document.getElementById(id);

export const fmt = {
  money(value) {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}조`;
    return `$${n.toFixed(n < 10 ? 1 : 0)}B`;
  },
  people(value) {
    const n = Number(value) || 0;
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}억`;
    if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만`;
    return n.toLocaleString('ko-KR');
  },
  int: (value) => Math.round(Number(value) || 0).toLocaleString('ko-KR'),
  one: (value) => (Number(value) || 0).toFixed(1),
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A stat tile: label, hero number, optional sub-line and magnitude meter. */
function statTile({ label, value, unit, sub, meter, wide }) {
  const node = el('div', `stat${wide ? ' wide' : ''}`);
  const figure = el('div', 'value', String(value));
  if (unit) figure.append(el('span', 'unit', unit));
  node.append(el('div', 'label', label), figure);
  if (sub) node.append(el('div', 'sub', sub));
  if (meter) {
    const track = el('div', `meter${meter.tone ? ` is-${meter.tone}` : ''}`);
    const fill = el('span');
    fill.style.width = `${Math.max(0, Math.min(100, meter.percent))}%`;
    track.append(fill);
    node.append(track);
  }
  return node;
}

export function renderStats(state) {
  const nation = state.player;
  const grid = $('stat-grid');
  grid.replaceChildren();

  const balance = nation.income - nation.expenses;
  const stabilityTone = nation.stability < 25 ? 'critical' : nation.stability < 45 ? 'warning' : null;
  const supportTone = nation.warSupport < 15 ? 'critical' : nation.warSupport < 35 ? 'warning' : null;

  grid.append(
    statTile({
      label: '국고',
      value: fmt.money(nation.treasury),
      sub: `${balance >= 0 ? '+' : ''}${fmt.money(balance)} / 월`,
    }),
    statTile({ label: 'GDP', value: fmt.money(nation.gdp), sub: `인구 ${fmt.people(nation.population)}` }),
    statTile({
      label: '병력',
      value: fmt.one(nation.divisions),
      unit: '사단',
      sub: `${fmt.people(nation.troops)}명 · 장비 ${nation.quality.toFixed(2)} · 기술 ${nation.tech}`,
    }),
    statTile({
      label: '동원 인력',
      value: fmt.people(nation.manpower),
      sub: `사단 편성비 ${fmt.money(nation.recruitCost)}`,
    }),
    statTile({
      label: '안정도',
      value: Math.round(nation.stability),
      meter: { percent: nation.stability, tone: stabilityTone },
      sub: stabilityTone === 'critical' ? '⚠ 통치 위기' : nation.government,
    }),
    statTile({
      label: '전쟁 지지',
      value: Math.round(nation.warSupport),
      meter: { percent: nation.warSupport, tone: supportTone },
      sub: `전쟁 피로 ${Math.round(nation.warExhaustion)}`,
    }),
  );

  if (nation.nukes > 0) {
    grid.append(
      statTile({
        label: '핵탄두',
        value: nation.nukes,
        unit: '발',
        sub: '사용 시 전 세계가 등을 돌립니다',
        wide: true,
      }),
    );
  }
  if (nation.occupiedByEnemy > 0) {
    grid.append(
      statTile({
        label: '⚠ 피점령 영토',
        value: nation.occupiedByEnemy,
        unit: '개 주',
        sub: '적군이 우리 영토를 통제하고 있습니다',
        wide: true,
      }),
    );
  }
}

export function renderWars(state) {
  const box = $('wars');
  box.replaceChildren();
  const player = state.meta.playerNation;
  const mine = state.wars.filter((war) => war.attackers.includes(player) || war.defenders.includes(player));

  if (!mine.length) {
    box.append(el('div', 'muted', '평화 상태입니다.'));
    const others = state.wars.length;
    if (others) box.append(el('div', 'muted tiny', `세계 각지에서 ${others}건의 전쟁이 진행 중입니다.`));
    return;
  }

  for (const war of mine) {
    const attacking = war.attackers.includes(player);
    const enemies = (attacking ? war.defenders : war.attackers)
      .map((code) => state.nations[code]?.name ?? code)
      .join(', ');
    const score = attacking ? war.warScore : -war.warScore;
    const verdict = score > 25 ? '우세' : score < -25 ? '열세' : '교착';
    const tone = score > 25 ? 'good' : score < -25 ? 'critical' : 'neutral';

    const row = el('div', 'row');
    const body = el('div', 'grow');
    body.append(el('div', 'name', `vs ${enemies}`));
    body.append(
      el('div', 'tiny muted', `${attacking ? '공세' : '방어'} · ${state.meta.turn - war.startTurn}개월째`),
    );
    const badge = el('span', `tag ${tone === 'good' ? 'ally' : tone === 'critical' ? 'war' : 'neutral'}`);
    badge.textContent = `${score > 0 ? '▲' : score < 0 ? '▼' : '■'} ${verdict} ${Math.round(score)}`;
    row.append(body, badge);
    box.append(row);
  }
}

export function renderRelations(state, colourIndex, theme) {
  const box = $('relations');
  box.replaceChildren();
  const player = state.player;

  const codes = new Set([
    ...player.atWarWith,
    ...player.allies,
    ...(player.neighbours ?? []),
    ...(player.rivals ?? []),
  ]);
  const rows = [...codes]
    .map((code) => state.nations[code])
    .filter(Boolean)
    .sort((a, b) => {
      const warA = player.atWarWith.includes(a.iso2) ? 0 : 1;
      const warB = player.atWarWith.includes(b.iso2) ? 0 : 1;
      return warA - warB || b.gdp - a.gdp;
    })
    .slice(0, 14);

  if (!rows.length) {
    box.append(el('div', 'muted', '특기할 관계가 없습니다.'));
    return;
  }

  for (const other of rows) {
    const relation = state.relations[other.iso2] ?? 0;
    const row = el('div', 'row');

    const swatch = el('span', 'swatch');
    swatch.style.background = colourFor(other.iso2, state, colourIndex, theme);
    const body = el('div', 'grow');
    body.append(el('div', 'name', other.name));
    body.append(
      el('div', 'tiny muted', `${fmt.money(other.gdp)} · ${fmt.one(other.divisions)}사단${other.nukes ? ` · ☢ ${other.nukes}` : ''}`),
    );

    let tag;
    if (player.atWarWith.includes(other.iso2)) tag = el('span', 'tag war', '⚔ 교전');
    else if (player.allies.includes(other.iso2)) tag = el('span', 'tag ally', '🤝 동맹');
    else if ((player.truces?.[other.iso2] ?? 0) > state.meta.turn) tag = el('span', 'tag truce', '✋ 정전');
    else tag = el('span', 'tag neutral', `${relation > 0 ? '+' : ''}${Math.round(relation)}`);

    row.append(swatch, body, tag);
    box.append(row);
  }
}

export function colourFor(iso2, state, colourIndex, theme) {
  if (iso2 === state.meta.playerNation) return PLAYER_COLOUR[theme];
  const index = colourIndex?.get(iso2);
  if (index === undefined) return theme === 'dark' ? '#4a4a46' : '#c3c2b7';
  return HUES[index][theme];
}

export function renderLegend(state, colourIndex, theme) {
  const box = $('legend');
  box.replaceChildren();

  const items = [
    { key: PLAYER_COLOUR[theme], label: `우리 영토 (${state.player.name})` },
    { key: 'hatch', label: '점령지 — 통제는 하지만 영유권은 없음' },
    { key: STATUS.critical, label: '교전 중인 전선 (점선)', border: true },
    { key: STATUS.warning, label: '이번 턴 영유권 이전', border: true },
    { key: STATUS.serious, label: '이번 턴 통제권 변동', border: true },
  ];

  for (const item of items) {
    const row = el('div', 'legend-item');
    const key = el('span', 'legend-key');
    if (item.key === 'hatch') {
      key.style.background = `repeating-linear-gradient(45deg, ${HUES[7][theme]} 0 2px, transparent 2px 5px), ${HUES[0][theme]}`;
    } else if (item.border) {
      key.style.background = 'transparent';
      key.style.borderColor = item.key;
      key.style.borderWidth = '2px';
    } else {
      key.style.background = item.key;
    }
    row.append(key, el('span', '', item.label));
    box.append(row);
  }

  const enemies = state.player.atWarWith.concat(state.player.allies).slice(0, 6);
  for (const code of enemies) {
    const nation = state.nations[code];
    if (!nation) continue;
    const row = el('div', 'legend-item');
    const key = el('span', 'legend-key');
    key.style.background = colourFor(code, state, colourIndex, theme);
    row.append(key, el('span', '', nation.name));
    box.append(row);
  }
}

/** Routine housekeeping by other nations is noise, not news. */
const ROUTINE_KINDS = new Set(['economy', 'military', 'movement', 'attrition']);

const KIND_GLYPH = {
  war: '⚔', peace: '🕊', capture: '🚩', battle: '💥', nuclear: '☢',
  collapse: '🏴', capitulation: '🏳', revolt: '✊', diplomacy: '🤝',
  economy: '💰', military: '🎖', movement: '➡', politics: '📢',
  statement: '🗣', attrition: '🩸', rejected: '⛔',
};

export function renderReport(state, report) {
  const box = $('report');
  box.replaceChildren();
  const narration = state.narration;

  $('report-turn').textContent = report ? report.date : '';

  if (!narration) {
    box.append(el('div', 'muted', '게임을 시작하면 매달 보고가 올라옵니다.'));
    return;
  }

  box.append(el('div', 'headline', narration.headline ?? ''));

  if (narration.report) {
    for (const paragraph of String(narration.report).split(/\n{2,}/)) {
      if (paragraph.trim()) box.append(el('p', '', paragraph.trim()));
    }
  }

  if (narration.advisories?.length) {
    const list = el('ul', 'advisories');
    for (const advisory of narration.advisories) list.append(el('li', '', advisory));
    box.append(list);
  }

  if (narration.offline) {
    box.append(el('div', 'tiny muted', 'API 키가 없어 자동 요약만 표시됩니다.'));
  }

  const player = state.meta.playerNation;
  const events = (report?.events ?? []).filter(
    (event) =>
      event.kind !== 'rejected' &&
      (event.nation === player || event.target === player || !ROUTINE_KINDS.has(event.kind)),
  );
  if (events.length) {
    const list = el('div', 'events');
    for (const event of events.slice(0, 40)) {
      const line = el('div', 'event-line');
      line.append(el('span', 'k', KIND_GLYPH[event.kind] ?? '·'));
      line.append(el('span', '', event.text));
      list.append(line);
    }
    box.append(list);
  }
}

/** The province inspector, with the direct orders available from here. */
export function renderSelection(state, geometry, provinceId, { colourIndex, theme, onOrder, onFocus }) {
  const box = $('selection');
  box.replaceChildren();

  if (!provinceId) {
    box.append(el('div', 'muted', '지도를 클릭해 지역을 선택하세요.'));
    return;
  }

  const geo = geometry.byId.get(provinceId);
  const live = state.provinces[provinceId];
  if (!geo || !live) return;

  const owner = state.nations[live.o];
  const controller = state.nations[live.c];
  const player = state.meta.playerNation;

  const head = el('div', 'head');
  const swatch = el('span', 'swatch');
  swatch.style.background = colourFor(live.o, state, colourIndex, theme);
  head.append(swatch, el('span', 'p-name', geo.name));
  const focus = el('button', 'ghost tiny', '지도에서 보기');
  focus.addEventListener('click', () => onFocus(provinceId));
  head.append(focus);
  box.append(head);

  const list = el('dl');
  const add = (term, value) => {
    list.append(el('dt', '', term), el('dd', '', value));
  };
  add('코드', provinceId);
  add('영유권', owner?.name ?? live.o);
  if (live.c !== live.o) add('실효 통제', `${controller?.name ?? live.c} (점령 중)`);
  add('인구', `${fmt.people(geo.population)}명`);
  add('면적', `${fmt.int(geo.area)} km²`);
  if (geo.cities?.length) add('주요 도시', geo.cities.slice(0, 3).map((c) => c.name).join(', '));
  add('해안', geo.coastal ? '접함' : '내륙');
  add('요새', `${live.f} / 5`);
  if (live.d > 0) add('황폐도', `${live.d}%`);
  if (live.u > 0) add('불안', `${live.u}%`);
  if (live.p > 0) add('전선 진척', `${live.p}%`);
  box.append(list);

  const armies = state.armies.filter((army) => army.province === provinceId);
  if (armies.length) {
    const forces = el('div', 'tiny');
    forces.textContent = `주둔 병력 — ${armies
      .map((army) => `${state.nations[army.owner]?.name ?? army.owner} ${fmt.one(army.strength)}사단`)
      .join(', ')}`;
    box.append(forces);
  }

  // Direct orders, so the game is fully playable without the language model.
  const actions = el('div', 'actions');
  const ourForce = armies.filter((army) => army.owner === player).reduce((s, a) => s + a.strength, 0);

  if (live.c === player) {
    if (live.f < 5) {
      const button = el('button', 'tiny', '요새 강화');
      button.addEventListener('click', () =>
        onOrder({ type: 'FORTIFY', province: provinceId, amount: state.player.treasury * 0.2 }),
      );
      actions.append(button);
    }
  } else {
    const atWar = state.player.atWarWith.includes(live.c);
    if (!atWar && live.c !== player) {
      const button = el('button', 'tiny', `${controller?.name ?? live.c}에 선전포고`);
      button.addEventListener('click', () =>
        onOrder({ type: 'DECLARE_WAR', target: live.c, casusBelli: `${geo.name}에 대한 영유권 주장` }),
      );
      actions.append(button);
    } else if (atWar) {
      // Only offer attack routes the engine would actually accept.
      for (const neighbour of geo.neighbours ?? []) {
        if (state.provinces[neighbour]?.c !== player) continue;
        const available = state.armies
          .filter((army) => army.province === neighbour && army.owner === player)
          .reduce((s, a) => s + a.strength, 0);
        if (available < 0.5) continue;
        const from = geometry.byId.get(neighbour);
        const button = el('button', 'tiny', `${from.name}에서 진격 (${fmt.one(available)}사단)`);
        button.addEventListener('click', () =>
          onOrder({ type: 'OFFENSIVE', from: neighbour, to: provinceId, commit: available }),
        );
        actions.append(button);
      }
    }
  }

  if (ourForce > 0.5 && live.c === player) {
    for (const neighbour of (geo.neighbours ?? []).slice(0, 6)) {
      if (state.provinces[neighbour]?.c !== player) continue;
      const to = geometry.byId.get(neighbour);
      const button = el('button', 'tiny', `${to.name}으로 이동`);
      button.addEventListener('click', () =>
        onOrder({ type: 'MOVE', from: provinceId, to: neighbour, commit: ourForce }),
      );
      actions.append(button);
    }
  }

  if (actions.childElementCount) box.append(actions);
}

export function renderTooltip(state, geometry, hover) {
  const tip = $('tooltip');
  if (!hover) {
    tip.hidden = true;
    return;
  }
  const { province, position } = hover;
  const live = state.provinces[province.id];
  const owner = state.nations[live?.o]?.name ?? live?.o ?? '—';

  tip.replaceChildren();
  tip.append(el('div', 't-name', province.name));
  tip.append(el('div', 't-row', owner));
  if (live && live.c !== live.o) {
    tip.append(el('div', 't-row', `${state.nations[live.c]?.name ?? live.c} 점령 중`));
  }
  tip.append(el('div', 't-row', `인구 ${fmt.people(province.population)}`));
  if (live?.p > 0) tip.append(el('div', 't-row', `전선 ${live.p}%`));

  const armies = state.armies.filter((army) => army.province === province.id);
  if (armies.length) {
    tip.append(
      el(
        'div',
        't-row',
        armies.map((a) => `${state.nations[a.owner]?.name ?? a.owner} ${fmt.one(a.strength)}사단`).join(' / '),
      ),
    );
  }

  tip.hidden = false;
  const wrap = tip.parentElement.getBoundingClientRect();
  const [x, y] = position;
  tip.style.left = `${Math.min(x + 14, wrap.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(y + 14, wrap.height - tip.offsetHeight - 8)}px`;
}

export function toast(message, { error = false, ms = 4200 } = {}) {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast${error ? ' error' : ''}`;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.hidden = true;
  }, ms);
}
