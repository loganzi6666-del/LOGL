/**
 * Creating, saving and loading a game.
 *
 * The state here is the single source of truth for everything that changes.
 * `data/world.json` never changes during play; this does.
 */

import { Rng, hashSeed } from './rng.js';
import { loadWorld } from './world.js';
import {
  DIPLOMACY,
  ECONOMY,
  MILITARY,
  TROOPS_PER_DIVISION,
  defenceShareFromSeed,
  divisionsFromPersonnel,
  qualityFromSpending,
  upkeepPerDivision,
} from './rules.js';

export const SAVE_VERSION = 1;

/**
 * Blocs whose members are treated as mutual defensive allies at game start.
 * US-ALLY and the "-ALIGNED" tags are one-sided: they raise relations with the
 * patron without creating a mutual pact between every client.
 */
const MUTUAL_BLOCS = new Set(['NATO', 'CSTO', 'GCC']);

const PATRON_BLOCS = {
  'US-ALLY': 'US',
  'US-ALIGNED': 'US',
  'WEST-ALIGNED': 'US',
  'CN-ALIGNED': 'CN',
  'RU-ALIGNED': 'RU',
  'RU-FRIENDLY': 'RU',
  'IN-ALIGNED': 'IN',
  'TR-ALIGNED': 'TR',
};

/** Standing antagonisms the bloc table alone would not capture. */
const RIVALRIES = [
  ['US', 'RU', -70], ['US', 'CN', -45], ['US', 'IR', -80], ['US', 'KP', -85],
  ['US', 'VE', -60], ['US', 'CU', -55], ['US', 'SY', -50],
  ['CN', 'IN', -45], ['CN', 'JP', -40], ['CN', 'TW', -85], ['CN', 'PH', -35],
  ['CN', 'VN', -30], ['CN', 'AU', -25],
  ['RU', 'UA', -95], ['RU', 'PL', -70], ['RU', 'GB', -70], ['RU', 'EE', -65],
  ['RU', 'LV', -65], ['RU', 'LT', -65], ['RU', 'FI', -55], ['RU', 'GE', -60],
  ['RU', 'MD', -50], ['RU', 'DE', -40], ['RU', 'FR', -40], ['RU', 'JP', -40],
  ['KR', 'KP', -85], ['KP', 'JP', -70], ['KR', 'JP', -10],
  ['IN', 'PK', -80], ['IL', 'IR', -90], ['IL', 'SY', -70], ['IL', 'LB', -60],
  ['SA', 'IR', -65], ['AE', 'IR', -45], ['TR', 'GR', -45], ['TR', 'SY', -40],
  ['TR', 'AM', -60], ['AZ', 'AM', -80], ['DZ', 'MA', -55],
  ['ET', 'EG', -45], ['ET', 'ER', -50], ['SD', 'SS', -45],
  ['VE', 'GY', -55], ['AR', 'GB', -30], ['RS', 'XK', -75], ['RW', 'CD', -55],
  ['TH', 'MM', -20], ['JP', 'CN', -40], ['PK', 'AF', -40], ['IR', 'AZ', -30],
];

/** Nations that carry enough weight that the AI always reasons about them. */
export const GREAT_POWERS = [
  'US', 'CN', 'RU', 'IN', 'JP', 'DE', 'GB', 'FR', 'KR', 'BR',
  'IT', 'CA', 'AU', 'TR', 'SA', 'IR', 'IL', 'PL', 'UA', 'KP',
  'PK', 'ID', 'MX', 'EG', 'ZA', 'NG', 'ES', 'VN', 'TW', 'AR',
];

export const relationKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function getRelation(state, a, b) {
  if (a === b) return 100;
  return state.relations[relationKey(a, b)] ?? 0;
}

export function setRelation(state, a, b, value) {
  if (a === b) return;
  state.relations[relationKey(a, b)] = Math.max(
    DIPLOMACY.MIN,
    Math.min(DIPLOMACY.MAX, Math.round(value * 10) / 10),
  );
}

export function adjustRelation(state, a, b, delta) {
  setRelation(state, a, b, getRelation(state, a, b) + delta);
}

/** Every nation that still holds at least one province. */
export function livingNations(state) {
  return Object.values(state.nations).filter((n) => n.alive);
}

export function provincesOf(state, iso2, { controlled = false } = {}) {
  const field = controlled ? 'controller' : 'owner';
  return Object.entries(state.provinces)
    .filter(([, p]) => p[field] === iso2)
    .map(([id]) => id);
}

export function areAllied(state, a, b) {
  return state.nations[a]?.allies?.includes(b) ?? false;
}

export function areAtWar(state, a, b) {
  return state.nations[a]?.atWarWith?.includes(b) ?? false;
}

function buildInitialRelations(state, world) {
  const nations = Object.values(state.nations);

  // Shared blocs pull nations together.
  for (let i = 0; i < nations.length; i += 1) {
    for (let j = i + 1; j < nations.length; j += 1) {
      const a = nations[i];
      const b = nations[j];
      const shared = a.blocs.filter((bloc) => b.blocs.includes(bloc));
      if (!shared.length) continue;
      let value = 0;
      for (const bloc of shared) value += MUTUAL_BLOCS.has(bloc) ? 45 : 25;
      setRelation(state, a.iso2, b.iso2, Math.min(85, value));
      if (shared.some((bloc) => MUTUAL_BLOCS.has(bloc))) {
        if (!a.allies.includes(b.iso2)) a.allies.push(b.iso2);
        if (!b.allies.includes(a.iso2)) b.allies.push(a.iso2);
      }
    }
  }

  // Client states line up behind their patron.
  for (const nation of nations) {
    for (const bloc of nation.blocs) {
      const patron = PATRON_BLOCS[bloc];
      if (!patron || patron === nation.iso2 || !state.nations[patron]) continue;
      setRelation(state, nation.iso2, patron, Math.max(getRelation(state, nation.iso2, patron), 65));
      if (bloc === 'US-ALLY') {
        if (!nation.allies.includes(patron)) nation.allies.push(patron);
        if (!state.nations[patron].allies.includes(nation.iso2)) {
          state.nations[patron].allies.push(nation.iso2);
        }
      }
    }
  }

  // Neighbours who are not allies rub against each other a little.
  for (const nation of nations) {
    const borders = new Set();
    for (const id of provincesOf(state, nation.iso2)) {
      for (const neighbour of world.neighbours(id)) {
        const other = state.provinces[neighbour]?.owner;
        if (other && other !== nation.iso2) borders.add(other);
      }
    }
    nation.neighbours = [...borders].sort();
    for (const other of borders) {
      if (areAllied(state, nation.iso2, other)) continue;
      const current = getRelation(state, nation.iso2, other);
      if (current === 0) setRelation(state, nation.iso2, other, -5);
    }
  }

  // Named antagonisms override everything above.
  for (const [a, b, value] of RIVALRIES) {
    if (!state.nations[a] || !state.nations[b]) continue;
    setRelation(state, a, b, value);
    state.nations[a].allies = state.nations[a].allies.filter((x) => x !== b);
    state.nations[b].allies = state.nations[b].allies.filter((x) => x !== a);
    if (!state.nations[a].rivals.includes(b)) state.nations[a].rivals.push(b);
    if (!state.nations[b].rivals.includes(a)) state.nations[b].rivals.push(a);
  }
}

/**
 * Put a nation's peacetime army on the map. Troops concentrate on the capital
 * and on borders with nations it distrusts, which is where they sit in reality.
 */
function deployInitialArmies(state, world, nation, rng) {
  const owned = provincesOf(state, nation.iso2);
  if (!owned.length || nation.divisions <= 0) return;

  const weights = owned.map((id) => {
    const province = world.province(id);
    const runtime = state.provinces[id];
    let weight = 1 + province.population / 4e6;
    if (nation.capitalProvince === id) weight += 8;
    for (const neighbour of world.neighbours(id)) {
      const other = state.provinces[neighbour]?.owner;
      if (!other || other === nation.iso2) continue;
      const relation = getRelation(state, nation.iso2, other);
      if (relation < -40) weight += 10;
      else if (relation < 0) weight += 3;
    }
    if (runtime.coastal) weight += 0.5;
    return weight;
  });

  // Concentrate the army in the most important places rather than smearing it.
  const ranked = owned
    .map((id, index) => ({ id, weight: weights[index] }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(1, Math.min(14, Math.ceil(owned.length * 0.6))));

  // Compress the spread so the capital does not swallow the entire army.
  for (const entry of ranked) entry.weight = entry.weight ** 0.6;
  const total = ranked.reduce((sum, entry) => sum + entry.weight, 0);
  let remaining = nation.divisions;

  ranked.forEach((entry, index) => {
    const isLast = index === ranked.length - 1;
    const share = isLast ? remaining : (nation.divisions * entry.weight) / total;
    const strength = Math.min(remaining, Math.round(share * 100) / 100);
    if (strength < 0.05) return;
    remaining -= strength;
    const id = `${nation.iso2}-A${index + 1}`;
    state.armies[id] = {
      id,
      owner: nation.iso2,
      province: entry.id,
      strength,
      morale: 1,
      entrenchment: rng.int(2, MILITARY.ENTRENCH_MAX),
      supply: 1,
    };
  });
}

/**
 * Start a new campaign.
 *
 * @param {object} options
 * @param {string} options.playerNation ISO 3166-1 alpha-2 code, e.g. "KR"
 * @param {string} [options.seed] any string; the same seed replays identically
 * @param {number} [options.startYear]
 */
export function newGame({ playerNation = 'KR', seed = null, startYear = 2025 } = {}) {
  const world = loadWorld();
  const actualSeed = seed ?? `logl-${Date.now()}`;
  const rng = new Rng(hashSeed(actualSeed));

  if (!world.nation(playerNation)) {
    throw new Error(`알 수 없는 국가 코드입니다: ${playerNation}`);
  }

  const state = {
    meta: {
      version: SAVE_VERSION,
      seed: actualSeed,
      rngState: rng.toJSON(),
      turn: 1,
      year: startYear,
      month: 1,
      playerNation,
      createdAt: new Date().toISOString(),
    },
    nations: {},
    provinces: {},
    armies: {},
    wars: [],
    relations: {},
    treaties: [],
    log: [],
    lastReport: null,
  };

  // Provinces first: ownership comes straight off the map.
  for (const province of world.provinceList) {
    state.provinces[province.id] = {
      owner: province.owner,
      controller: province.owner,
      coreOwner: province.coreOwner,
      devastation: 0,
      unrest: 0,
      fortLevel: 0,
      frontProgress: 0,
      baseOutput: 0,
      coastal: province.coastal,
    };
  }

  // Nations, with their economy and army derived from real figures.
  for (const [iso2, meta] of world.nations) {
    const owned = world.byCore.get(iso2) ?? [];
    const controls = Object.entries(state.provinces).filter(([, p]) => p.owner === iso2);
    // A dependency (Greenland, Guam…) is not a separate player: its land is
    // already owned by its sovereign, so it has no army or treasury of its own.
    const isSovereign = !meta.sovereign;
    if (!isSovereign && controls.length === 0) {
      continue;
    }

    const budget = meta.military?.budget ?? 0;
    const active = meta.military?.active ?? 0;
    const gdp = meta.gdp ?? Math.max(1, meta.population / 1e6);
    const population = meta.population ?? 0;
    const perCapita = population > 0 ? (gdp * 1e9) / population : 5000;

    const divisions = divisionsFromPersonnel(active);
    const quality = qualityFromSpending({ budget, active, gdp, population });
    const upkeep = upkeepPerDivision({ budget, active, gdp, population });
    const defenceShare = defenceShareFromSeed({ budget, gdp });

    state.nations[iso2] = {
      iso2,
      name: meta.name,
      nameKo: meta.nameKo,
      government: meta.government ?? '정부',
      doctrine: meta.doctrine ?? null,
      blocs: meta.blocs ?? [],
      region: meta.region,
      capitalProvince: meta.capitalProvince,
      capitalCity: meta.capitalCity,
      sovereign: meta.sovereign ?? null,
      isPlayer: iso2 === playerNation,
      alive: controls.length > 0,

      population,
      gdp,
      gdpPerCapita: Math.round(perCapita),
      treasury: Math.max(2, (gdp * defenceShare) / 12) * 4, // four months of budget banked
      defenceShare,
      income: 0,
      expenses: 0,

      divisions,
      reserveDivisions: 0,
      quality: Math.round(quality * 1000) / 1000,
      upkeepPerDivision: upkeep,
      nukes: meta.military?.nukes ?? 0,
      manpowerMax: Math.round(population * 0.05),
      manpower: Math.round(population * 0.05 * 0.4),
      tech: Math.max(
        1,
        Math.min(10, Math.round(1 + 9 * ((Math.log10(Math.max(300, perCapita)) - 2.7) / 2.3))),
      ),

      stability: 60,
      warSupport: 55,
      warExhaustion: 0,

      allies: [],
      rivals: [],
      neighbours: [],
      atWarWith: [],
      truces: {},
      guarantees: [],
    };
  }

  // Province economic output: the nation's GDP split by where its people live.
  for (const nation of Object.values(state.nations)) {
    const owned = provincesOf(state, nation.iso2);
    const totalWeight = owned.reduce((sum, id) => {
      const province = world.province(id);
      return sum + province.population * (0.6 + province.urbanisation);
    }, 0);
    if (totalWeight <= 0) continue;
    for (const id of owned) {
      const province = world.province(id);
      const weight = province.population * (0.6 + province.urbanisation);
      state.provinces[id].baseOutput = Number(((nation.gdp * weight) / totalWeight).toFixed(4));
    }
  }

  buildInitialRelations(state, world);

  for (const nation of Object.values(state.nations)) {
    deployInitialArmies(state, world, nation, rng);
  }

  // Capitals and border provinces start fortified.
  for (const nation of Object.values(state.nations)) {
    if (nation.capitalProvince && state.provinces[nation.capitalProvince]) {
      state.provinces[nation.capitalProvince].fortLevel = 3;
    }
    for (const id of provincesOf(state, nation.iso2)) {
      for (const neighbour of world.neighbours(id)) {
        const other = state.provinces[neighbour]?.owner;
        if (!other || other === nation.iso2) continue;
        if (getRelation(state, nation.iso2, other) < -50) {
          state.provinces[id].fortLevel = Math.max(state.provinces[id].fortLevel, 2);
        }
      }
    }
  }

  state.meta.rngState = rng.toJSON();
  state.log.push({
    turn: 0,
    kind: 'start',
    text: `${state.nations[playerNation].nameKo} 정부가 출범했습니다. ${startYear}년 1월.`,
  });

  return state;
}

/** Nation-level totals that are derived, not stored, so they can never drift. */
export function recomputeNation(state, world, iso2) {
  recomputeAll(state, world, [iso2]);
}

/**
 * Recompute every nation's derived totals in a single pass over the map.
 *
 * Doing this per nation would mean walking all 1,600 provinces once per country
 * every time, which dominated turn resolution. One pass keeps a turn cheap even
 * with two hundred nations on the board.
 */
export function recomputeAll(state, world, only = null) {
  const scope = only ? new Set(only) : null;
  const totals = new Map();
  for (const iso2 of Object.keys(state.nations)) {
    if (scope && !scope.has(iso2)) continue;
    totals.set(iso2, {
      gdp: 0,
      controlled: 0,
      occupiedByEnemy: 0,
      population: 0,
      occupationCost: 0,
      divisions: 0,
    });
  }

  for (const [id, province] of Object.entries(state.provinces)) {
    const held = totals.get(province.controller);
    if (held) {
      held.controlled += 1;
      const isOwn = province.owner === province.controller;
      const output =
        province.baseOutput *
        (1 - province.devastation) *
        (isOwn ? 1 : ECONOMY.OCCUPIED_OUTPUT) *
        (1 - Math.min(0.8, province.unrest / 150));
      held.gdp += output;
      if (isOwn) held.population += world.province(id).population;
      else held.occupationCost += province.baseOutput * ECONOMY.OCCUPATION_COST;
    }
    if (province.owner !== province.controller) {
      const dispossessed = totals.get(province.owner);
      if (dispossessed) dispossessed.occupiedByEnemy += 1;
    }
  }

  for (const army of Object.values(state.armies)) {
    const entry = totals.get(army.owner);
    if (entry) entry.divisions += army.strength;
  }

  for (const [iso2, entry] of totals) {
    const nation = state.nations[iso2];
    if (!nation) continue;
    nation.gdp = Number(entry.gdp.toFixed(3));
    nation.controlledProvinces = entry.controlled;
    nation.occupiedByEnemy = entry.occupiedByEnemy;
    nation.population = entry.population;
    nation.occupationCost = Number(entry.occupationCost.toFixed(4));
    nation.gdpPerCapita =
      entry.population > 0 ? Math.round((entry.gdp * 1e9) / entry.population) : 0;
    nation.divisions = Number(entry.divisions.toFixed(2));
    nation.troops = Math.round(entry.divisions * TROOPS_PER_DIVISION);
    nation.alive = entry.controlled > 0 || entry.divisions > 0;
  }
}
