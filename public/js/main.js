/**
 * Application wiring: start screen, map, panels, and the turn loop.
 */

import { api } from './api.js';
import { WorldMap } from './map.js';
import { colourNations } from './palette.js';
import {
  colourFor,
  fmt,
  renderLegend,
  renderRelations,
  renderReport,
  renderSelection,
  renderStats,
  renderTooltip,
  renderWars,
  toast,
} from './ui.js';

const $ = (id) => document.getElementById(id);

const app = {
  geometry: null,
  colourIndex: null,
  state: null,
  map: null,
  theme: 'light',
  selected: null,
  pendingOrders: [],
  lastInstruction: '',
  busy: false,
};

// ── Theme ───────────────────────────────────────────────────────────────────

function initTheme() {
  const stored = (() => {
    try {
      return localStorage.getItem('logl-theme');
    } catch {
      return null;
    }
  })();
  const system = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(stored ?? system, false);
}

function setTheme(theme, persist = true) {
  app.theme = theme;
  document.documentElement.dataset.theme = theme;
  app.map?.setTheme(theme);
  if (persist) {
    try {
      localStorage.setItem('logl-theme', theme);
    } catch {
      /* a private window is not a reason to fail */
    }
  }
  if (app.state) refreshPanels();
}

// ── Start screen ────────────────────────────────────────────────────────────

let playable = [];
let chosen = null;

async function initStartScreen() {
  const { nations, aiEnabled, provider } = await api.playable();
  playable = nations;

  const status = $('ai-status');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = aiEnabled ? '#0ca30c' : '#fab219';
  status.replaceChildren(dot);
  status.append(
    aiEnabled
      ? `AI 연결됨 — ${provider === 'openai' ? 'ChatGPT' : 'Claude'}. 자연어로 지시할 수 있습니다.`
      : 'API 키가 없습니다. 규칙 기반으로 플레이할 수 있고, .env에 키를 넣으면 자연어 명령과 AI 국가가 켜집니다.',
  );

  renderNationList('');
  $('nation-search').addEventListener('input', (event) => renderNationList(event.target.value));
  $('start-btn').addEventListener('click', startGame);

  const { saves } = await api.saves().catch(() => ({ saves: [] }));
  renderSaves(saves);

  // Korea is the default pick, since that is where most players will start.
  const initial = playable.find((nation) => nation.iso2 === 'KR') ?? playable[0];
  if (initial) selectNation(initial);
}

function renderNationList(query) {
  const list = $('nation-list');
  const needle = query.trim().toLowerCase();
  const matches = playable
    .filter(
      (nation) =>
        !needle ||
        nation.name.toLowerCase().includes(needle) ||
        nation.nameEn.toLowerCase().includes(needle) ||
        nation.iso2.toLowerCase() === needle,
    )
    .slice(0, 80);

  list.replaceChildren();
  for (const nation of matches) {
    const button = document.createElement('button');
    button.className = 'nation-item';
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(chosen?.iso2 === nation.iso2));
    button.innerHTML = '';
    const name = document.createElement('div');
    name.className = 'n';
    name.textContent = nation.name;
    const meta = document.createElement('div');
    meta.className = 'm';
    meta.textContent = `${fmt.money(nation.gdp)} · ${fmt.people(nation.population)}명${nation.nukes ? ' · ☢' : ''}`;
    button.append(name, meta);
    button.addEventListener('click', () => selectNation(nation));
    list.append(button);
  }
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '10px';
    empty.textContent = '검색 결과가 없습니다.';
    list.append(empty);
  }
}

function selectNation(nation) {
  chosen = nation;
  $('start-btn').disabled = false;
  for (const item of $('nation-list').querySelectorAll('.nation-item')) {
    item.setAttribute('aria-selected', String(item.querySelector('.n').textContent === nation.name));
  }

  const detail = $('nation-detail');
  detail.hidden = false;
  detail.replaceChildren();
  const title = document.createElement('div');
  title.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = `${nation.name} (${nation.iso2})`;
  title.append(strong, document.createTextNode(` · ${nation.government ?? ''}`));
  detail.append(title);

  const stats = document.createElement('div');
  stats.style.margin = '6px 0';
  stats.textContent = `GDP ${fmt.money(nation.gdp)} · 인구 ${fmt.people(nation.population)}명 · 상비군 ${fmt.people(nation.active)}명${nation.nukes ? ` · 핵탄두 ${nation.nukes}발` : ''}`;
  detail.append(stats);

  if (nation.doctrine) {
    const doctrine = document.createElement('div');
    doctrine.textContent = nation.doctrine;
    detail.append(doctrine);
  }
}

function renderSaves(saves) {
  const box = $('saves-list');
  box.replaceChildren();
  if (!saves.length) {
    box.textContent = '저장된 게임이 없습니다.';
    return;
  }
  for (const save of saves) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const label = document.createElement('span');
    label.textContent = `${save.name} — ${save.nationName ?? save.nation} · ${save.date}`;
    const button = document.createElement('button');
    button.className = 'tiny';
    button.textContent = '불러오기';
    button.addEventListener('click', async () => {
      try {
        await enterGame(await api.load(save.name));
      } catch (error) {
        toast(error.message, { error: true });
      }
    });
    row.append(label, button);
    box.append(row);
  }
}

async function startGame() {
  if (!chosen) return;
  $('start-btn').disabled = true;
  $('start-btn').textContent = '세계를 만드는 중…';
  try {
    const state = await api.newGame({ nation: chosen.iso2, seed: $('seed').value.trim() || null });
    await enterGame(state);
  } catch (error) {
    toast(error.message, { error: true });
    $('start-btn').disabled = false;
    $('start-btn').textContent = '게임 시작';
  }
}

// ── Game shell ──────────────────────────────────────────────────────────────

async function enterGame(state) {
  if (!app.geometry) {
    const payload = await api.geometry();
    app.geometry = {
      provinces: payload.provinces,
      byId: new Map(payload.provinces.map((province) => [province.id, province])),
      nations: payload.nations,
      adjacency: payload.adjacency,
    };
    app.colourIndex = colourNations(payload.adjacency, Object.keys(payload.nations));
  }

  $('start').hidden = true;
  $('shell').hidden = false;

  if (!app.map) {
    app.map = new WorldMap($('map'), {
      onSelect: (id) => {
        app.selected = id;
        refreshSelection();
      },
      onHover: (hover) => renderTooltip(app.state, app.geometry, hover),
    });
    app.map.colourIndex = app.colourIndex;
    app.map.load({
      provinces: app.geometry.provinces,
      adjacency: app.geometry.adjacency,
      nations: app.geometry.nations,
    });
    app.map.setTheme(app.theme);
    wireShell();
  }

  applyState(state);
  app.map.zoomTo(state.player.capitalProvince, 5);
}

function applyState(state) {
  app.state = state;
  app.map.setState(state);
  refreshPanels();
  refreshSelection();
}

function refreshPanels() {
  const state = app.state;
  if (!state) return;

  $('date-label').textContent = `${state.meta.date} · ${state.meta.turn}턴`;

  const chip = $('player-chip');
  chip.replaceChildren();
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = colourFor(state.meta.playerNation, state, app.colourIndex, app.theme);
  const label = document.createElement('span');
  label.textContent = `${state.player.name} · ${state.player.controlledProvinces}개 주`;
  chip.append(swatch, label);

  renderStats(state);
  renderWars(state);
  renderRelations(state, app.colourIndex, app.theme);
  renderLegend(state, app.colourIndex, app.theme);
  renderReport(state, state.meta.lastReport ?? app.lastReport);
  renderPending();
}

function refreshSelection() {
  renderSelection(app.state, app.geometry, app.selected, {
    colourIndex: app.colourIndex,
    theme: app.theme,
    onFocus: (id) => app.map.zoomTo(id, 12),
    onOrder: (order) => queueOrder(order),
  });
}

// ── Orders ──────────────────────────────────────────────────────────────────

function queueOrder(order) {
  app.pendingOrders.push(order);
  renderPending();
  toast('명령이 대기열에 추가되었습니다. "턴 종료"를 누르면 실행됩니다.');
}

function describeOrder(order) {
  const name = (id) => app.geometry.byId.get(id)?.name ?? id;
  const nation = (code) => app.state.nations[code]?.name ?? code;
  switch (order.type) {
    case 'OFFENSIVE':
      return `${name(order.from)} → ${name(order.to)} 진격 (${fmt.one(order.commit)}사단)`;
    case 'NAVAL_INVASION':
      return `${name(order.from)} → ${name(order.to)} 상륙 (${fmt.one(order.commit)}사단)`;
    case 'MOVE':
      return `${name(order.from)} → ${name(order.to)} 이동 (${fmt.one(order.commit)}사단)`;
    case 'DECLARE_WAR':
      return `${nation(order.target)}에 선전포고 — ${order.casusBelli ?? ''}`;
    case 'PROPOSE_PEACE':
      return order.whitePeace
        ? `${nation(order.target)}에 백지 강화 제안`
        : `${nation(order.target)}에 강화 제안 (할양 ${(order.annex ?? []).map(name).join(', ') || '없음'})`;
    case 'RECRUIT':
      return `${fmt.one(order.divisions)}개 사단 편성`;
    case 'FORTIFY':
      return `${name(order.province)} 요새 강화 (${fmt.money(order.amount)})`;
    case 'INVEST':
      return `${order.target === 'research' ? '기술' : '경제'} 투자 ${fmt.money(order.amount)}`;
    case 'SET_DEFENCE_SHARE':
      return `국방예산 GDP의 ${(order.value * 100).toFixed(2)}%로 조정`;
    case 'IMPROVE_RELATIONS':
      return `${nation(order.target)} 관계 개선 ${fmt.money(order.amount)}`;
    case 'MILITARY_AID':
      return `${nation(order.target)}에 군사원조 ${fmt.money(order.amount)}`;
    case 'FORM_ALLIANCE':
      return `${nation(order.target)}에 동맹 제안`;
    case 'SANCTION':
      return `${nation(order.target)} 경제 제재`;
    case 'NUCLEAR_STRIKE':
      return `☢ ${name(order.province)}에 핵 공격`;
    case 'STATEMENT':
      return `성명: ${order.text}`;
    default:
      return order.type;
  }
}

function renderPending(extra = null) {
  const box = $('pending');
  box.replaceChildren();

  const hasOrders = app.pendingOrders.length > 0;
  if (!hasOrders && !extra) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  if (extra?.understanding) {
    const line = document.createElement('div');
    line.className = 'understanding';
    line.textContent = extra.understanding;
    box.append(line);
  }
  if (extra?.reply) {
    const reply = document.createElement('div');
    reply.className = 'muted';
    reply.textContent = extra.reply;
    box.append(reply);
  }

  if (hasOrders) {
    const list = document.createElement('ol');
    app.pendingOrders.forEach((order, index) => {
      const item = document.createElement('li');
      item.textContent = describeOrder(order);
      const remove = document.createElement('button');
      remove.className = 'ghost tiny';
      remove.textContent = '취소';
      remove.addEventListener('click', () => {
        app.pendingOrders.splice(index, 1);
        renderPending();
      });
      item.append(' ', remove);
      list.append(item);
    });
    box.append(list);
  }

  for (const refusal of extra?.rejected ?? []) {
    const line = document.createElement('div');
    line.className = 'refused';
    line.textContent = `⛔ ${refusal.reason}`;
    box.append(line);
  }
}

// ── The turn ────────────────────────────────────────────────────────────────

function setBusy(busy, text = '턴 처리 중…') {
  app.busy = busy;
  $('map-busy').hidden = !busy;
  $('busy-text').textContent = text;
  $('turn-btn').disabled = busy;
  $('interpret-btn').disabled = busy;
}

async function interpret() {
  const instruction = $('command').value.trim();
  if (!instruction) {
    toast('지시 내용을 입력하세요.');
    return;
  }
  setBusy(true, '참모본부가 지시를 검토 중…');
  try {
    const result = await api.interpret(instruction);
    app.lastInstruction = instruction;
    if (result.isQuestion) {
      renderPending({ understanding: result.understanding, reply: result.reply });
      $('command-hint').textContent = '질문으로 판단해 명령을 만들지 않았습니다.';
    } else {
      app.pendingOrders.push(...result.orders);
      renderPending(result);
      $('command-hint').textContent = result.orders.length
        ? `${result.orders.length}개 명령이 준비되었습니다. "턴 종료"로 실행하세요.`
        : '실행 가능한 명령을 만들지 못했습니다.';
    }
  } catch (error) {
    toast(error.message, { error: true });
  } finally {
    setBusy(false);
  }
}

async function endTurn() {
  setBusy(true, app.state.meta.aiEnabled ? '각국 정부가 결정을 내리는 중…' : '턴 처리 중…');
  try {
    const { report, narration, state } = await api.turn({
      orders: app.pendingOrders,
      instruction: app.lastInstruction || null,
    });

    app.pendingOrders = [];
    app.lastInstruction = '';
    app.lastReport = report;
    $('command').value = '';
    $('command-hint').textContent = '';

    applyState(state);
    renderReport(state, report);
    if (report.mapChanges.length) app.map.highlightChanges(report.mapChanges);

    if (report.playerRejected?.length) {
      toast(`거부된 명령 ${report.playerRejected.length}건: ${report.playerRejected[0].reason}`, {
        error: true,
        ms: 7000,
      });
    } else if (narration?.headline) {
      toast(narration.headline, { ms: 5500 });
    }
  } catch (error) {
    toast(error.message, { error: true, ms: 8000 });
  } finally {
    setBusy(false);
  }
}

// ── Shell wiring ────────────────────────────────────────────────────────────

function wireShell() {
  $('turn-btn').addEventListener('click', endTurn);
  $('interpret-btn').addEventListener('click', interpret);

  const command = $('command');
  command.addEventListener('input', () => {
    command.style.height = 'auto';
    command.style.height = `${Math.min(140, command.scrollHeight)}px`;
  });
  command.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      interpret();
    }
  });

  $('theme-btn').addEventListener('click', () => setTheme(app.theme === 'dark' ? 'light' : 'dark'));
  $('fit-btn').addEventListener('click', () => app.map.resetZoom());
  $('home-btn').addEventListener('click', () => app.map.zoomTo(app.state.player.capitalProvince, 6));

  $('save-btn').addEventListener('click', async () => {
    const name = prompt('저장 이름을 입력하세요 (영문/숫자/-/_)', `${app.state.meta.playerNation}-${app.state.meta.turn}턴`.replace(/[^\w-]/g, ''));
    if (!name) return;
    try {
      await api.save(name);
      toast(`"${name}"으로 저장했습니다.`);
    } catch (error) {
      toast(error.message, { error: true });
    }
  });

  $('legend-toggle').addEventListener('click', (event) => {
    const legend = $('legend');
    const collapsed = legend.hidden;
    legend.hidden = !collapsed;
    event.target.textContent = collapsed ? '접기' : '펼치기';
    event.target.setAttribute('aria-expanded', String(collapsed));
  });

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'Enter' && !app.busy) endTurn();
    if (event.key === 'Escape') {
      app.selected = null;
      app.map.selected = null;
      app.map.render();
      refreshSelection();
    }
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

// Exposed for debugging and for the smoke test's assertions.
window.__logl = app;

initTheme();
initStartScreen().catch((error) => {
  toast(`초기화 실패: ${error.message}`, { error: true, ms: 10000 });
});
