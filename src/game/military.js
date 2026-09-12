/**
 * Movement, supply and combat.
 *
 * Provinces change hands here and nowhere else. The LLM decides what a nation
 * attempts; this file decides whether it works. Every outcome comes from the
 * seeded RNG plus the state, so the same save and the same orders always produce
 * the same war.
 */

import { MILITARY, TROOPS_PER_DIVISION, climateAttackModifier, divisionPower } from './rules.js';
import { areAllied, areAtWar, getRelation } from './state.js';

/** Nations whose territory an army may move through without fighting. */
function friendlyTo(state, owner, other) {
  return owner === other || areAllied(state, owner, other);
}

/**
 * Which provinces each nation can actually supply: everything reachable overland
 * from its capital through ground it or its allies control. An army outside this
 * set is cut off and fights at a fraction of its strength.
 */
export function computeSupplyNetworks(state, world) {
  const networks = new Map();

  for (const nation of Object.values(state.nations)) {
    if (!nation.alive) continue;
    const reachable = new Set();

    // Start from the capital if it is still held, otherwise from whatever
    // home territory remains — a government in exile still supplies its army.
    const seeds = [];
    if (nation.capitalProvince && state.provinces[nation.capitalProvince]?.controller === nation.iso2) {
      seeds.push(nation.capitalProvince);
    } else {
      for (const [id, province] of Object.entries(state.provinces)) {
        if (province.controller === nation.iso2 && province.owner === nation.iso2) seeds.push(id);
      }
    }

    const queue = [...seeds];
    for (const id of seeds) reachable.add(id);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      for (const next of world.neighbours(current)) {
        if (reachable.has(next)) continue;
        const controller = state.provinces[next]?.controller;
        if (!controller || !friendlyTo(state, nation.iso2, controller)) continue;
        reachable.add(next);
        queue.push(next);
      }
    }
    networks.set(nation.iso2, reachable);
  }

  return networks;
}

/** Refresh every army's supply level and apply attrition to the cut-off ones. */
export function updateSupply(state, world, networks, events) {
  for (const army of Object.values(state.armies)) {
    const network = networks.get(army.owner);
    const inNetwork = network?.has(army.province) ?? false;
    const province = state.provinces[army.province];

    let target;
    if (inNetwork) {
      target = 1;
    } else if (province?.coastal && province.controller === army.owner) {
      // A beachhead can be kept alive over the sea, but barely.
      target = MILITARY.AMPHIBIOUS_SUPPLY;
    } else {
      target = 0.2;
    }

    // Supply changes gradually so a temporary encirclement is survivable.
    army.supply = Number((army.supply + (target - army.supply) * 0.5).toFixed(3));

    if (army.supply < 0.5) {
      const lost = army.strength * MILITARY.UNSUPPLIED_ATTRITION * (1 - army.supply);
      army.strength = Number(Math.max(0, army.strength - lost).toFixed(3));
      army.morale = Math.max(0.2, army.morale - 0.04);
      if (lost > 0.2) {
        events.push({
          kind: 'attrition',
          nation: army.owner,
          province: army.province,
          text: `${nationName(state, army.owner)}군이 ${provinceName(world, army.province)}에서 보급 두절로 ${fmtTroops(lost)} 손실.`,
        });
      }
    }
  }
  removeEmptyArmies(state);
}

export function removeEmptyArmies(state) {
  for (const [id, army] of Object.entries(state.armies)) {
    if (army.strength < 0.02) delete state.armies[id];
  }
}

const nationName = (state, iso2) => state.nations[iso2]?.nameKo ?? iso2;
const provinceName = (world, id) => world.province(id)?.name ?? id;
const fmtTroops = (divisions) =>
  `${Math.round(divisions * TROOPS_PER_DIVISION).toLocaleString('ko-KR')}명`;

/** Total strength a nation has sitting in one province. */
export function garrisonIn(state, province, owner) {
  return Object.values(state.armies)
    .filter((army) => army.province === province && army.owner === owner)
    .reduce((sum, army) => sum + army.strength, 0);
}

export function armiesIn(state, province, owner = null) {
  return Object.values(state.armies).filter(
    (army) => army.province === province && (owner === null || army.owner === owner),
  );
}

/** Take `amount` divisions out of a nation's stacks in a province. */
function detach(state, province, owner, amount) {
  const stacks = armiesIn(state, province, owner);
  let remaining = amount;
  let taken = 0;
  let morale = 0;
  let supply = 0;
  let weight = 0;

  for (const army of stacks) {
    if (remaining <= 0) break;
    const slice = Math.min(army.strength, remaining);
    army.strength = Number((army.strength - slice).toFixed(3));
    remaining -= slice;
    taken += slice;
    morale += army.morale * slice;
    supply += army.supply * slice;
    weight += slice;
  }
  removeEmptyArmies(state);
  return {
    strength: Number(taken.toFixed(3)),
    morale: weight > 0 ? morale / weight : 1,
    supply: weight > 0 ? supply / weight : 1,
  };
}

/** Put divisions into a province, merging with whatever is already there. */
export function placeForce(state, province, owner, force) {
  if (force.strength <= 0) return;
  const existing = armiesIn(state, province, owner)[0];
  if (existing) {
    const total = existing.strength + force.strength;
    existing.morale = (existing.morale * existing.strength + force.morale * force.strength) / total;
    existing.supply = (existing.supply * existing.strength + force.supply * force.strength) / total;
    existing.strength = Number(total.toFixed(3));
    existing.entrenchment = Math.min(existing.entrenchment, 2);
    return;
  }
  let index = 1;
  while (state.armies[`${owner}-A${index}`]) index += 1;
  const id = `${owner}-A${index}`;
  state.armies[id] = {
    id,
    owner,
    province,
    strength: Number(force.strength.toFixed(3)),
    morale: force.morale,
    supply: force.supply,
    entrenchment: 0,
  };
}

/** Defensive strength of a province that has no field army in it. */
function garrisonPower(state, world, province) {
  const runtime = state.provinces[province];
  const geo = world.province(province);
  const controller = state.nations[runtime.controller];
  if (!controller) return 0;
  const base = Math.min(60, geo.population / 1e6) * 6 * (0.4 + 0.6 * controller.quality);
  const loyalty = runtime.owner === runtime.controller ? 1 : 0.45;
  return base * loyalty * (1 + runtime.fortLevel * MILITARY.FORT_BONUS);
}

function defenceMultiplier(state, world, province, amphibious) {
  const runtime = state.provinces[province];
  const geo = world.province(province);
  const armies = armiesIn(state, province, runtime.controller);
  const entrench = armies.length
    ? armies.reduce((sum, a) => sum + a.entrenchment * a.strength, 0) /
      Math.max(0.01, armies.reduce((sum, a) => sum + a.strength, 0))
    : 0;

  let multiplier = 1;
  multiplier *= 1 + runtime.fortLevel * MILITARY.FORT_BONUS;
  multiplier *= 1 + Math.min(MILITARY.ENTRENCH_MAX, entrench) * MILITARY.ENTRENCH_BONUS;
  multiplier *= 1 + geo.urbanisation * MILITARY.URBAN_BONUS;
  if (amphibious) multiplier *= 1.35; // defending a shoreline is easy
  return multiplier;
}

function attackMultiplier(state, world, target, amphibious) {
  const geo = world.province(target);
  let multiplier = climateAttackModifier(geo.climate);
  if (amphibious) multiplier *= MILITARY.AMPHIBIOUS_PENALTY;
  return multiplier;
}

function forcePower(state, owner, force) {
  const nation = state.nations[owner];
  if (!nation) return 0;
  return (
    force.strength *
    divisionPower({
      quality: nation.quality,
      morale: force.morale,
      supply: force.supply,
      techBonus: (nation.tech - 5) * 0.035,
    })
  );
}

/**
 * Resolve one turn of fighting over a province.
 *
 * Battles do not end in a single turn. Each turn the front advances or falls
 * back, and the province only changes hands once the attacker has pushed the
 * front all the way through. That gives both sides time to react — and gives the
 * player time to sue for peace before losing a capital.
 */
export function resolveBattle(state, world, rng, { target, attackers, amphibious }, events) {
  const runtime = state.provinces[target];
  const defender = runtime.controller;
  const geo = world.province(target);

  const attackerNations = [...new Set(attackers.map((a) => a.owner))];
  const attackPower =
    attackers.reduce((sum, entry) => sum + forcePower(state, entry.owner, entry.force), 0) *
    attackMultiplier(state, world, target, amphibious);

  const defenderArmies = armiesIn(state, target, defender);
  const defenderForce = defenderArmies.reduce(
    (acc, army) => {
      acc.strength += army.strength;
      acc.morale += army.morale * army.strength;
      acc.supply += army.supply * army.strength;
      return acc;
    },
    { strength: 0, morale: 0, supply: 0 },
  );
  if (defenderForce.strength > 0) {
    defenderForce.morale /= defenderForce.strength;
    defenderForce.supply /= defenderForce.strength;
  } else {
    defenderForce.morale = 1;
    defenderForce.supply = 1;
  }

  const defencePower =
    (forcePower(state, defender, defenderForce) + garrisonPower(state, world, target)) *
    defenceMultiplier(state, world, target, amphibious);

  const roll = rng.variance(0.3);
  const ratio = (attackPower / Math.max(1, defencePower)) * roll;

  const gain = Math.max(
    MILITARY.PROGRESS_MIN,
    Math.min(MILITARY.PROGRESS_MAX, MILITARY.PROGRESS_SCALE * (ratio - MILITARY.STALL_RATIO)),
  );
  runtime.frontProgress = Math.max(0, runtime.frontProgress + gain);

  // Casualties: each side bleeds in proportion to what it is facing.
  const attackerTotal = attackers.reduce((sum, entry) => sum + entry.force.strength, 0);
  const attackerNation = state.nations[attackerNations[0]];
  const defenderNation = state.nations[defender];

  const attackerLosses =
    (defencePower * MILITARY.LOSS_RATE * rng.variance(0.35)) /
    Math.max(30, divisionPower({ quality: attackerNation?.quality ?? 0.5, morale: 1, supply: 1 }));
  const defenderLosses =
    (attackPower * MILITARY.LOSS_RATE * rng.variance(0.35)) /
    Math.max(30, divisionPower({ quality: defenderNation?.quality ?? 0.5, morale: 1, supply: 1 }));

  const attackerLost = Math.min(attackerTotal, attackerLosses);
  const defenderLost = Math.min(defenderForce.strength, defenderLosses);

  // Apply attacker losses proportionally across the committed forces.
  if (attackerTotal > 0) {
    for (const entry of attackers) {
      entry.force.strength = Number(
        Math.max(0, entry.force.strength - attackerLost * (entry.force.strength / attackerTotal)).toFixed(3),
      );
      entry.force.morale = Math.max(0.15, entry.force.morale - (gain > 0 ? 0.01 : MILITARY.MORALE_LOSS));
    }
  }

  // And defender losses across the stacks actually holding the ground.
  if (defenderForce.strength > 0) {
    for (const army of defenderArmies) {
      const share = army.strength / defenderForce.strength;
      army.strength = Number(Math.max(0, army.strength - defenderLost * share).toFixed(3));
      army.morale = Math.max(0.15, army.morale - (gain > 0 ? MILITARY.MORALE_LOSS : 0.01));
      army.entrenchment = Math.max(0, army.entrenchment - 2);
    }
  }
  removeEmptyArmies(state);

  const casualties = {
    attacker: Math.round(attackerLost * TROOPS_PER_DIVISION),
    defender: Math.round(defenderLost * TROOPS_PER_DIVISION),
  };
  for (const iso2 of attackerNations) {
    const nation = state.nations[iso2];
    if (nation) nation.monthlyCasualties = (nation.monthlyCasualties ?? 0) + casualties.attacker / attackerNations.length;
  }
  if (defenderNation) {
    defenderNation.monthlyCasualties = (defenderNation.monthlyCasualties ?? 0) + casualties.defender;
  }

  const captured = runtime.frontProgress >= MILITARY.CAPTURE_THRESHOLD;
  let newController = defender;

  if (captured) {
    newController = attackerNations[0];
    runtime.frontProgress = 0;
    runtime.controller = newController;
    runtime.devastation = Math.min(0.9, runtime.devastation + 0.15);
    runtime.unrest = Math.min(100, runtime.unrest + 20);
    runtime.fortLevel = Math.max(0, runtime.fortLevel - 1);

    // Surviving defenders fall back to an adjacent friendly province, or
    // surrender if there is nowhere to go.
    const retreat = world
      .neighbours(target)
      .find((id) => friendlyTo(state, defender, state.provinces[id]?.controller));
    for (const army of armiesIn(state, target, defender)) {
      if (retreat) {
        army.province = retreat;
        army.entrenchment = 0;
        army.morale = Math.max(0.2, army.morale - 0.15);
      } else {
        delete state.armies[army.id];
      }
    }

    // The attackers move in.
    for (const entry of attackers) {
      placeForce(state, target, entry.owner, entry.force);
      entry.force.strength = 0;
    }

    events.push({
      kind: 'capture',
      nation: newController,
      target: defender,
      province: target,
      text:
        `${nationName(state, newController)}군이 ${provinceName(world, target)}을(를) 점령했습니다. ` +
        `(공격측 ${casualties.attacker.toLocaleString('ko-KR')}명, 방어측 ${casualties.defender.toLocaleString('ko-KR')}명 손실)`,
    });
  } else {
    events.push({
      kind: 'battle',
      nation: attackerNations[0],
      target: defender,
      province: target,
      progress: Math.round(runtime.frontProgress),
      text:
        `${provinceName(world, target)} 전선: ${nationName(state, attackerNations[0])}군 공세 ` +
        `${gain > 0 ? `${Math.round(gain)} 전진 (전선 ${Math.round(runtime.frontProgress)}%)` : '격퇴됨'}. ` +
        `공격측 ${casualties.attacker.toLocaleString('ko-KR')}명, 방어측 ${casualties.defender.toLocaleString('ko-KR')}명 손실.`,
    });
  }

  return { captured, newController, casualties, progress: runtime.frontProgress, gain };
}

/** Armies that fought nowhere this turn dig in and recover. */
export function restAndEntrench(state, engagedProvinces) {
  for (const army of Object.values(state.armies)) {
    if (engagedProvinces.has(army.province)) continue;
    army.entrenchment = Math.min(MILITARY.ENTRENCH_MAX, army.entrenchment + MILITARY.ENTRENCH_PER_TURN);
    army.morale = Math.min(1, army.morale + MILITARY.MORALE_REGEN * army.supply);
  }
}

/** Front lines with no fighting this turn slowly settle back. */
export function decayFronts(state, engagedProvinces) {
  for (const [id, province] of Object.entries(state.provinces)) {
    if (engagedProvinces.has(id) || province.frontProgress <= 0) continue;
    province.frontProgress = Math.max(0, province.frontProgress - 12);
  }
}

export { detach };
