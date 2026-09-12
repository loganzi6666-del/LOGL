/**
 * The rule-based AI that runs the nations no language model is spent on.
 *
 * With two hundred states on the map, calling a model for each one every month
 * would be slow and expensive. These rules keep the rest of the world moving
 * plausibly — defending what they hold, pressing an advantage, suing for peace
 * when beaten — so the map is never static outside the player's attention.
 */

import { MILITARY } from '../game/rules.js';
import { areAtWar, getRelation, provincesOf } from '../game/state.js';
import { armiesIn, garrisonIn } from '../game/military.js';
import { findWar, scoreFor } from '../game/diplomacy.js';

/** Strength this nation could bring to bear on a province, from adjacent ground. */
function attackOptions(state, world, iso2) {
  const options = [];
  for (const id of provincesOf(state, iso2, { controlled: true })) {
    const available = garrisonIn(state, id, iso2);
    if (available < 1) continue;
    for (const neighbour of world.neighbours(id)) {
      const runtime = state.provinces[neighbour];
      if (!runtime || !areAtWar(state, iso2, runtime.controller)) continue;
      const defenders = armiesIn(state, neighbour, runtime.controller).reduce(
        (sum, army) => sum + army.strength,
        0,
      );
      const defenderQuality = state.nations[runtime.controller]?.quality ?? 0.5;
      const ourQuality = state.nations[iso2]?.quality ?? 0.5;
      // Rough local balance, before terrain and fortification.
      const edge =
        (available * ourQuality) /
        Math.max(0.5, defenders * defenderQuality * (1 + runtime.fortLevel * 0.25));
      options.push({ from: id, to: neighbour, available, defenders, edge, progress: runtime.frontProgress });
    }
  }
  return options.sort((a, b) => b.progress - a.progress || b.edge - a.edge);
}

/** Provinces of ours under attack, worst first. */
function threatenedProvinces(state, world, iso2) {
  const threats = [];
  for (const id of provincesOf(state, iso2, { controlled: true })) {
    const runtime = state.provinces[id];
    let hostile = 0;
    for (const neighbour of world.neighbours(id)) {
      const other = state.provinces[neighbour];
      if (!other || !areAtWar(state, iso2, other.controller)) continue;
      hostile += armiesIn(state, neighbour, other.controller).reduce((s, a) => s + a.strength, 0);
    }
    if (hostile <= 0) continue;
    const held = garrisonIn(state, id, iso2);
    threats.push({ id, hostile, held, deficit: hostile - held, progress: runtime.frontProgress });
  }
  return threats.sort((a, b) => b.progress - a.progress || b.deficit - a.deficit);
}

function wartimeOrders(state, world, iso2, rng) {
  const nation = state.nations[iso2];
  const orders = [];

  // Sue for peace when the war is lost, or cash in when it is won.
  for (const enemy of nation.atWarWith) {
    const war = findWar(state, iso2, enemy);
    if (!war) continue;
    const score = scoreFor(war, iso2);

    if (score < -35 && nation.warExhaustion > 25) {
      orders.push({ type: 'PROPOSE_PEACE', target: enemy, whitePeace: true });
      continue;
    }
    if (score > 45) {
      const spoils = Object.entries(state.provinces)
        .filter(([, p]) => p.controller === iso2 && p.owner === enemy)
        .map(([id]) => id);
      // Ask for what the front line can actually justify.
      const affordable = Math.max(1, Math.floor(spoils.length * Math.min(1, score / 100)));
      orders.push({
        type: 'PROPOSE_PEACE',
        target: enemy,
        annex: spoils.slice(0, affordable),
        reparations: 0,
      });
    } else if (nation.warExhaustion > 70 && score < 10) {
      orders.push({ type: 'PROPOSE_PEACE', target: enemy, whitePeace: true });
    }
  }

  // Shore up whatever is about to fall.
  const threats = threatenedProvinces(state, world, iso2);
  const reinforced = new Set();
  for (const threat of threats.slice(0, 3)) {
    if (threat.deficit <= 0) continue;
    const donor = Object.values(state.armies)
      .filter(
        (army) =>
          army.owner === iso2 &&
          army.province !== threat.id &&
          army.strength > 1 &&
          world.neighbours(army.province).includes(threat.id),
      )
      .sort((a, b) => b.strength - a.strength)[0];
    if (!donor) continue;
    orders.push({
      type: 'MOVE',
      from: donor.province,
      to: threat.id,
      commit: Math.min(donor.strength, Math.max(1, threat.deficit)),
    });
    reinforced.add(donor.province);
  }

  // Press attacks only where the odds are genuinely favourable.
  const options = attackOptions(state, world, iso2).filter((o) => !reinforced.has(o.from));
  const committed = new Set();
  for (const option of options) {
    if (committed.has(option.from)) continue;
    const worthIt = option.edge > 1.4 || (option.progress > 25 && option.edge > 0.9);
    if (!worthIt) continue;
    orders.push({ type: 'OFFENSIVE', from: option.from, to: option.to, commit: option.available });
    committed.add(option.from);
    if (committed.size >= 4) break;
  }

  // Replace losses.
  const costPerDivision = nation.upkeepPerDivision * 30;
  if (nation.treasury > costPerDivision * 2) {
    orders.push({ type: 'RECRUIT', divisions: Math.max(1, nation.divisions * 0.05) });
  }
  // Wars are paid for.
  if (nation.defenceShare < 0.08 && nation.warExhaustion < 60) {
    orders.push({ type: 'SET_DEFENCE_SHARE', value: Math.min(0.1, nation.defenceShare * 1.35) });
  }

  return orders;
}

function peacetimeOrders(state, world, iso2, rng) {
  const nation = state.nations[iso2];
  const orders = [];
  const reserve = Math.max(2, nation.income * 3);

  // Fortify against a neighbour that hates us, if we can afford it.
  const enemyNeighbour = nation.neighbours.find(
    (other) => getRelation(state, iso2, other) < -45 && state.nations[other]?.alive,
  );
  if (enemyNeighbour && nation.treasury > reserve * 2 && rng.chance(0.25)) {
    const border = provincesOf(state, iso2, { controlled: true }).find((id) => {
      if (state.provinces[id].fortLevel >= 4) return false;
      return world.neighbours(id).some((n) => state.provinces[n]?.owner === enemyNeighbour);
    });
    if (border) {
      orders.push({ type: 'FORTIFY', province: border, amount: nation.treasury * 0.25 });
    }
  }

  // Keep the army roughly in proportion to what we can pay for.
  const sustainable = (nation.income * 0.6) / Math.max(1e-6, nation.upkeepPerDivision);
  if (nation.divisions < sustainable * 0.9 && nation.treasury > reserve) {
    orders.push({ type: 'RECRUIT', divisions: Math.max(0.5, nation.divisions * 0.04) });
  }

  // Otherwise put the surplus to work.
  if (nation.treasury > reserve * 4 && rng.chance(0.5)) {
    orders.push({
      type: 'INVEST',
      target: rng.chance(0.25) ? 'research' : 'economy',
      amount: nation.treasury * 0.4,
    });
  }

  // A state that is far stronger than a hated, weakened neighbour may take its
  // chance. This is what keeps the world from freezing into permanent peace.
  if (!nation.atWarWith.length && nation.warExhaustion < 20 && rng.chance(0.05)) {
    const ourPower = nation.divisions * nation.quality;

    const candidates = nation.neighbours
      .map((code) => state.nations[code])
      .filter(
        (victim) =>
          victim?.alive &&
          (nation.truces?.[victim.iso2] ?? 0) <= state.meta.turn &&
          getRelation(state, iso2, victim.iso2) < -35,
      );

    for (const victim of rng.shuffle(candidates)) {
      // An ally that would be dragged in is the main deterrent to aggression.
      const backing = victim.allies.reduce((sum, code) => {
        const friend = state.nations[code];
        if (!friend?.alive) return sum;
        return sum + friend.divisions * friend.quality * 0.6;
      }, 0);
      const theirPower = victim.divisions * victim.quality + backing;
      const ratio = ourPower / Math.max(0.5, theirPower);
      if (ratio < 1.4) continue;

      const hatred = -getRelation(state, iso2, victim.iso2) / 100;
      const fragility = Math.max(0, (65 - victim.stability) / 65);
      const appetite = (ratio - 1.4) * 0.45 + fragility * 0.5 + hatred * 0.35;
      if (!rng.chance(Math.min(0.6, appetite))) continue;

      orders.push({
        type: 'DECLARE_WAR',
        target: victim.iso2,
        casusBelli: `${victim.nameKo}의 정세 불안이 우리 안보에 직접적 위협이 되고 있습니다.`,
      });
      break;
    }
  }

  return orders;
}

/** Decide one nation's month without a language model. */
export function heuristicOrders(state, world, iso2, rng) {
  const nation = state.nations[iso2];
  if (!nation?.alive) return [];
  return nation.atWarWith.length
    ? wartimeOrders(state, world, iso2, rng)
    : peacetimeOrders(state, world, iso2, rng);
}
