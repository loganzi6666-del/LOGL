/**
 * Turn resolution.
 *
 * One call to `resolveTurn` takes everybody's orders for the month and produces
 * the new state plus a report of what happened. The order of the phases is the
 * order of cause and effect: you declare war before you can attack, you fight
 * before you count the cost, and you pay for it at the end of the month.
 */

import { Rng } from './rng.js';
import { ECONOMY, MILITARY, NUCLEAR, POLITICS, TROOPS_PER_DIVISION } from './rules.js';
import {
  applyPeace,
  callAllies,
  checkAnnihilation,
  computeWarScore,
  declareWar,
  driftRelations,
  evaluatePeaceOffer,
  findWar,
} from './diplomacy.js';
import { invest, recruit, settleBudget, tickHomeFront, tickProvinces } from './economy.js';
import {
  armiesIn,
  computeSupplyNetworks,
  decayFronts,
  detach,
  placeForce,
  removeEmptyArmies,
  resolveBattle,
  restAndEntrench,
  updateSupply,
} from './military.js';
import { validateOrders } from './orders.js';
import {
  adjustRelation,
  areAllied,
  areAtWar,
  getRelation,
  provincesOf,
  recomputeAll,
  recomputeNation,
} from './state.js';

const MONTH_NAMES = [
  '1월', '2월', '3월', '4월', '5월', '6월',
  '7월', '8월', '9월', '10월', '11월', '12월',
];

export function formatDate(state) {
  return `${state.meta.year}년 ${MONTH_NAMES[state.meta.month - 1]}`;
}

/** A snapshot of who owns and controls what, for diffing after the turn. */
function snapshotMap(state) {
  const snapshot = new Map();
  for (const [id, province] of Object.entries(state.provinces)) {
    snapshot.set(id, `${province.owner}/${province.controller}`);
  }
  return snapshot;
}

function diffMap(before, state) {
  const changes = [];
  for (const [id, province] of Object.entries(state.provinces)) {
    const previous = before.get(id);
    const current = `${province.owner}/${province.controller}`;
    if (previous !== current) {
      const [wasOwner, wasController] = previous.split('/');
      changes.push({
        province: id,
        owner: province.owner,
        controller: province.controller,
        previousOwner: wasOwner,
        previousController: wasController,
        annexed: wasOwner !== province.owner,
      });
    }
  }
  return changes;
}

// ── Phases ──────────────────────────────────────────────────────────────────

function phaseDiplomacy(state, world, rng, ordersByNation, events) {
  for (const [iso2, orders] of ordersByNation) {
    const nation = state.nations[iso2];
    if (!nation?.alive) continue;

    for (const order of orders) {
      switch (order.type) {
        case 'DECLARE_WAR': {
          const result = declareWar(state, world, iso2, order.target, {
            casusBelli: order.casusBelli,
          });
          if (!result.ok) {
            events.push({ kind: 'rejected', nation: iso2, text: result.reason });
            break;
          }
          events.push({
            kind: 'war',
            nation: iso2,
            target: order.target,
            text: `${nation.nameKo}이(가) ${state.nations[order.target].nameKo}에 선전포고했습니다. 명분: ${order.casusBelli}`,
          });
          callAllies(state, world, result.war, rng, events);
          break;
        }

        case 'PROPOSE_PEACE': {
          const war = findWar(state, iso2, order.target);
          if (!war) break;
          computeWarScore(state, world, war);
          const terms = {
            annex: order.annex,
            reparations: order.reparations,
            whitePeace: order.whitePeace,
          };
          const verdict = evaluatePeaceOffer(state, world, war, { proposer: iso2, terms });
          if (verdict.accept) {
            applyPeace(state, world, war, { proposer: iso2, terms }, events);
          } else {
            events.push({
              kind: 'diplomacy',
              nation: iso2,
              target: order.target,
              text: `${state.nations[order.target].nameKo}이(가) ${nation.nameKo}의 강화 제안을 거부했습니다. (${verdict.reason})`,
            });
          }
          break;
        }

        case 'FORM_ALLIANCE': {
          const target = state.nations[order.target];
          const relation = getRelation(state, iso2, order.target);
          // An alliance is worth signing if they like you and you are useful.
          const weight = Math.log10(Math.max(1, nation.gdp)) * 6;
          const willing = relation + weight - target.atWarWith.length * 20;
          if (willing >= 70 && rng.chance(0.75)) {
            nation.allies.push(order.target);
            target.allies.push(iso2);
            adjustRelation(state, iso2, order.target, 15);
            events.push({
              kind: 'diplomacy',
              nation: iso2,
              target: order.target,
              text: `${nation.nameKo}과(와) ${target.nameKo}이(가) 동맹을 체결했습니다.`,
            });
          } else {
            events.push({
              kind: 'diplomacy',
              nation: iso2,
              target: order.target,
              text: `${target.nameKo}이(가) ${nation.nameKo}의 동맹 제안을 거절했습니다. (관계 ${relation.toFixed(0)})`,
            });
          }
          break;
        }

        case 'BREAK_ALLIANCE': {
          nation.allies = nation.allies.filter((x) => x !== order.target);
          state.nations[order.target].allies = state.nations[order.target].allies.filter(
            (x) => x !== iso2,
          );
          adjustRelation(state, iso2, order.target, -30);
          events.push({
            kind: 'diplomacy',
            nation: iso2,
            target: order.target,
            text: `${nation.nameKo}이(가) ${state.nations[order.target].nameKo}과(와)의 동맹을 파기했습니다.`,
          });
          break;
        }

        case 'IMPROVE_RELATIONS': {
          nation.treasury -= order.amount;
          const gain = Math.min(25, (order.amount / Math.max(1, nation.gdp * 0.002)) * 2);
          adjustRelation(state, iso2, order.target, gain);
          events.push({
            kind: 'diplomacy',
            nation: iso2,
            target: order.target,
            text: `${nation.nameKo}이(가) ${state.nations[order.target].nameKo}과(와)의 관계 개선에 ${order.amount.toFixed(1)}B USD를 투입했습니다. (관계 +${gain.toFixed(0)})`,
          });
          break;
        }

        case 'MILITARY_AID': {
          const target = state.nations[order.target];
          nation.treasury -= order.amount;
          target.treasury += order.amount;
          adjustRelation(state, iso2, order.target, Math.min(20, order.amount));
          // Arming someone the world is fighting is noticed.
          for (const enemy of target.atWarWith) {
            adjustRelation(state, iso2, enemy, -Math.min(25, order.amount * 1.5));
          }
          events.push({
            kind: 'diplomacy',
            nation: iso2,
            target: order.target,
            text: `${nation.nameKo}이(가) ${target.nameKo}에 ${order.amount.toFixed(1)}B USD 규모의 군사 원조를 제공했습니다.`,
          });
          break;
        }

        case 'SANCTION': {
          const target = state.nations[order.target];
          const leverage = Math.min(0.12, (nation.gdp / Math.max(1, target.gdp)) * 0.05);
          target.sanctionPressure = (target.sanctionPressure ?? 0) + leverage;
          nation.sanctionCost = (nation.sanctionCost ?? 0) + leverage * 0.25;
          adjustRelation(state, iso2, order.target, -20);
          events.push({
            kind: 'diplomacy',
            nation: iso2,
            target: order.target,
            text: `${nation.nameKo}이(가) ${target.nameKo}에 경제 제재를 부과했습니다.`,
          });
          break;
        }

        case 'STATEMENT': {
          events.push({
            kind: 'statement',
            nation: iso2,
            text: `[${nation.nameKo} 성명] ${order.text}`,
          });
          break;
        }

        default:
          break;
      }
    }
  }
}

function phaseNuclear(state, world, rng, ordersByNation, events) {
  const strikes = [];
  for (const [iso2, orders] of ordersByNation) {
    for (const order of orders) {
      if (order.type === 'NUCLEAR_STRIKE') strikes.push({ iso2, province: order.province });
    }
  }
  if (!strikes.length) return;

  for (const strike of strikes) {
    const nation = state.nations[strike.iso2];
    const runtime = state.provinces[strike.province];
    if (!nation?.alive || !runtime || nation.nukes <= 0) continue;
    const victim = state.nations[runtime.controller];

    nation.nukes -= 1;
    runtime.devastation = Math.min(0.95, runtime.devastation + NUCLEAR.DEVASTATION);
    runtime.unrest = Math.min(100, runtime.unrest + 40);
    runtime.fortLevel = 0;
    runtime.baseOutput = Number((runtime.baseOutput * 0.25).toFixed(4));

    const geo = world.province(strike.province);
    const dead = Math.round(geo.population * NUCLEAR.CASUALTY_RATE);

    // Anything standing there is gone.
    for (const army of armiesIn(state, strike.province)) {
      army.strength = Number((army.strength * 0.2).toFixed(3));
      army.morale = 0.2;
    }
    removeEmptyArmies(state);

    if (victim) {
      victim.stability = Math.max(0, victim.stability - 25);
      victim.warSupport = Math.min(100, victim.warSupport + 20); // rally round the flag
      victim.monthlyCasualties = (victim.monthlyCasualties ?? 0) + dead;
    }

    for (const other of Object.values(state.nations)) {
      if (other.iso2 === strike.iso2 || !other.alive) continue;
      adjustRelation(state, strike.iso2, other.iso2, -NUCLEAR.GLOBAL_OUTRAGE);
    }
    nation.stability = Math.max(0, nation.stability - 10);

    events.push({
      kind: 'nuclear',
      nation: strike.iso2,
      target: runtime.controller,
      province: strike.province,
      text:
        `${nation.nameKo}이(가) ${geo.name}에 핵무기를 사용했습니다. ` +
        `약 ${dead.toLocaleString('ko-KR')}명이 사망한 것으로 추정됩니다. 전 세계가 경악했습니다.`,
    });

    // Retaliation is near-automatic between nuclear powers.
    if (victim && victim.nukes > 0 && rng.chance(NUCLEAR.RETALIATION_CHANCE)) {
      const targets = provincesOf(state, strike.iso2, { controlled: true });
      const capital = state.nations[strike.iso2].capitalProvince;
      const retaliationTarget =
        capital && state.provinces[capital]?.controller === strike.iso2
          ? capital
          : rng.pick(targets);
      if (retaliationTarget) {
        strikes.push({ iso2: victim.iso2, province: retaliationTarget, retaliation: true });
      }
    }
  }
}

function phaseMovement(state, world, ordersByNation, events) {
  for (const [iso2, orders] of ordersByNation) {
    for (const order of orders) {
      if (order.type !== 'MOVE') continue;
      const force = detach(state, order.from, iso2, order.commit);
      if (force.strength <= 0) continue;
      placeForce(state, order.to, iso2, force);
      events.push({
        kind: 'movement',
        nation: iso2,
        province: order.to,
        text: `${state.nations[iso2].nameKo}군 ${force.strength.toFixed(1)}개 사단이 ${world.province(order.from).name}에서 ${world.province(order.to).name}으로 이동했습니다.`,
      });
    }
  }
}

function phaseCombat(state, world, rng, ordersByNation, events) {
  // Everyone attacking the same province fights one battle over it.
  const fronts = new Map();

  for (const [iso2, orders] of ordersByNation) {
    for (const order of orders) {
      if (order.type !== 'OFFENSIVE' && order.type !== 'NAVAL_INVASION') continue;
      const force = detach(state, order.from, iso2, order.commit);
      if (force.strength <= 0.02) continue;
      if (order.type === 'NAVAL_INVASION') force.supply = MILITARY.AMPHIBIOUS_SUPPLY;

      let front = fronts.get(order.to);
      if (!front) {
        front = { target: order.to, attackers: [], amphibious: true };
        fronts.set(order.to, front);
      }
      front.attackers.push({ owner: iso2, force, from: order.from });
      if (order.type === 'OFFENSIVE') front.amphibious = false;
    }
  }

  const engaged = new Set();
  const results = [];

  for (const front of fronts.values()) {
    const defender = state.provinces[front.target].controller;
    // Someone else may have taken the province before this attack lands.
    const stillHostile = front.attackers.filter((entry) => areAtWar(state, entry.owner, defender));
    if (!stillHostile.length) {
      for (const entry of front.attackers) placeForce(state, entry.from, entry.owner, entry.force);
      continue;
    }

    engaged.add(front.target);
    const outcome = resolveBattle(
      state,
      world,
      rng,
      { target: front.target, attackers: stillHostile, amphibious: front.amphibious },
      events,
    );
    results.push({ front: front.target, ...outcome });

    // Survivors of a failed assault fall back to where they started.
    if (!outcome.captured) {
      for (const entry of stillHostile) {
        if (entry.force.strength > 0) placeForce(state, entry.from, entry.owner, entry.force);
      }
    }

    // Warscore bookkeeping.
    for (const entry of stillHostile) {
      const war = findWar(state, entry.owner, defender);
      if (!war) continue;
      const attackerIsPrimary = war.attackers.includes(entry.owner);
      if (outcome.gain > 0) {
        if (attackerIsPrimary) war.battlesWon = (war.battlesWon ?? 0) + 1;
        else war.battlesLost = (war.battlesLost ?? 0) + 1;
      } else if (attackerIsPrimary) {
        war.battlesLost = (war.battlesLost ?? 0) + 1;
      } else {
        war.battlesWon = (war.battlesWon ?? 0) + 1;
      }
      if (outcome.captured) {
        const nation = state.nations[entry.owner];
        nation.warSupport = Math.min(100, nation.warSupport + POLITICS.SUPPORT_PER_CONQUEST);
      }
    }
  }

  return { engaged, results };
}

function phaseEconomy(state, world, ordersByNation, events) {
  for (const [iso2, orders] of ordersByNation) {
    const nation = state.nations[iso2];
    if (!nation?.alive) continue;

    for (const order of orders) {
      switch (order.type) {
        case 'RECRUIT': {
          const result = recruit(state, world, nation, order.divisions, events);
          if (!result.ok) events.push({ kind: 'rejected', nation: iso2, text: result.reason });
          break;
        }
        case 'FORTIFY': {
          const result = invest(
            state,
            world,
            nation,
            { target: 'fortify', amount: order.amount, province: order.province },
            events,
          );
          if (!result.ok) events.push({ kind: 'rejected', nation: iso2, text: result.reason });
          break;
        }
        case 'INVEST': {
          const result = invest(
            state,
            world,
            nation,
            { target: order.target, amount: order.amount },
            events,
          );
          if (!result.ok) events.push({ kind: 'rejected', nation: iso2, text: result.reason });
          break;
        }
        case 'SET_DEFENCE_SHARE': {
          const previous = nation.defenceShare;
          nation.defenceShare = order.value;
          // Guns come out of somebody's butter.
          const jump = order.value - previous;
          if (jump > 0) {
            nation.stability = Math.max(0, nation.stability - jump * 300);
            events.push({
              kind: 'economy',
              nation: iso2,
              text: `${nation.nameKo}이(가) 국방예산을 GDP의 ${(order.value * 100).toFixed(1)}%로 증액했습니다. 사회적 반발이 있습니다.`,
            });
          } else if (jump < 0) {
            nation.stability = Math.min(100, nation.stability - jump * 120);
            events.push({
              kind: 'economy',
              nation: iso2,
              text: `${nation.nameKo}이(가) 국방예산을 GDP의 ${(order.value * 100).toFixed(1)}%로 감축했습니다.`,
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Sanctions bite, then wear off.
  for (const nation of Object.values(state.nations)) {
    const pressure = nation.sanctionPressure ?? 0;
    if (pressure > 0) {
      for (const id of provincesOf(state, nation.iso2, { controlled: true })) {
        const runtime = state.provinces[id];
        runtime.baseOutput = Number((runtime.baseOutput * (1 - Math.min(0.05, pressure))).toFixed(4));
      }
      nation.stability = Math.max(0, nation.stability - pressure * 8);
      nation.sanctionPressure = pressure * 0.8;
      if (nation.sanctionPressure < 0.002) nation.sanctionPressure = 0;
    }
    const cost = nation.sanctionCost ?? 0;
    if (cost > 0) {
      nation.treasury -= nation.gdp * cost * 0.002;
      nation.sanctionCost = cost * 0.8;
      if (nation.sanctionCost < 0.002) nation.sanctionCost = 0;
    }
  }

  for (const nation of Object.values(state.nations)) {
    if (!nation.alive) continue;
    settleBudget(state, world, nation, events);
  }
}

function phasePolitics(state, world, rng, events) {
  for (const nation of Object.values(state.nations)) {
    if (!nation.alive) continue;
    tickHomeFront(state, world, nation);

    // A government that has lost its grip stops being able to prosecute a war.
    if (nation.stability < POLITICS.CRISIS_STABILITY && rng.chance(0.08)) {
      nation.warSupport = Math.max(0, nation.warSupport - 10);
      events.push({
        kind: 'politics',
        nation: nation.iso2,
        text: `${nation.nameKo}에서 대규모 시위가 벌어졌습니다. 정부의 통제력이 약해지고 있습니다.`,
      });
    }
  }
  tickProvinces(state, world, rng, events);
  driftRelations(state);
}

/**
 * Nations whose people will no longer fight give up, whatever their government
 * wants. Without this a losing AI would hold out forever and the war could
 * never end.
 */
function phaseCapitulation(state, world, events) {
  for (const war of [...state.wars]) {
    computeWarScore(state, world, war);
    for (const side of ['attackers', 'defenders']) {
      const lead = side === 'attackers' ? war.leadAttacker : war.leadDefender;
      const nation = state.nations[lead];
      if (!nation?.alive) continue;
      const score = side === 'attackers' ? war.warScore : -war.warScore;
      const broken =
        nation.warSupport <= POLITICS.COLLAPSE_SUPPORT && score < -25 && nation.warExhaustion > 50;
      if (!broken) continue;

      // Hand over what the winner already holds and stop the war.
      const winner = side === 'attackers' ? war.leadDefender : war.leadAttacker;
      const winnerSide = side === 'attackers' ? war.defenders : war.attackers;
      const annex = Object.entries(state.provinces)
        .filter(([, p]) => winnerSide.includes(p.controller) && p.owner === lead)
        .map(([id]) => id);
      applyPeace(state, world, war, { proposer: winner, terms: { annex, reparations: 0 } }, events);
      events.push({
        kind: 'capitulation',
        nation: lead,
        target: winner,
        text: `${nation.nameKo}이(가) 전쟁을 지속할 수 없게 되어 항복했습니다.`,
      });
      break;
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Resolve one month.
 *
 * @param {object} state mutated in place
 * @param {object} world static map
 * @param {Map<string, object[]>|object} rawOrders orders keyed by nation code
 * @returns {object} a report of everything that happened
 */
export function resolveTurn(state, world, rawOrders) {
  const rng = Rng.fromJSON(state.meta.rngState);
  const events = [];
  const before = snapshotMap(state);

  const entries =
    rawOrders instanceof Map ? [...rawOrders.entries()] : Object.entries(rawOrders ?? {});

  // Validate everything up front so nobody acts on a state that a rejected
  // order has already half-changed.
  const validated = new Map();
  const rejected = {};
  for (const [iso2, orders] of entries) {
    const result = validateOrders(state, world, iso2, orders);
    if (result.accepted.length) validated.set(iso2, result.accepted);
    if (result.rejected.length) rejected[iso2] = result.rejected;
  }

  // Randomise who acts first so no nation gets a permanent initiative advantage.
  const order = rng.shuffle([...validated.keys()]);
  const shuffled = new Map(order.map((iso2) => [iso2, validated.get(iso2)]));

  phaseDiplomacy(state, world, rng, shuffled, events);
  phaseNuclear(state, world, rng, shuffled, events);
  phaseMovement(state, world, shuffled, events);
  const { engaged } = phaseCombat(state, world, rng, shuffled, events);

  const networks = computeSupplyNetworks(state, world);
  updateSupply(state, world, networks, events);
  restAndEntrench(state, engaged);
  decayFronts(state, engaged);

  recomputeAll(state, world);
  phaseEconomy(state, world, shuffled, events);
  phasePolitics(state, world, rng, events);

  recomputeAll(state, world);
  phaseCapitulation(state, world, events);
  checkAnnihilation(state, world, events);
  recomputeAll(state, world);

  for (const war of state.wars) computeWarScore(state, world, war);

  const mapChanges = diffMap(before, state);

  // Advance the calendar.
  state.meta.turn += 1;
  state.meta.month += 1;
  if (state.meta.month > 12) {
    state.meta.month = 1;
    state.meta.year += 1;
  }
  state.meta.rngState = rng.toJSON();

  const report = {
    turn: state.meta.turn - 1,
    date: `${state.meta.year}년 ${MONTH_NAMES[state.meta.month - 1]}`,
    events,
    mapChanges,
    rejected,
    wars: state.wars.map((war) => ({
      id: war.id,
      attackers: war.attackers,
      defenders: war.defenders,
      warScore: war.warScore,
      startTurn: war.startTurn,
      casusBelli: war.casusBelli,
    })),
  };

  state.log.push(
    ...events.map((event) => ({ turn: report.turn, ...event })),
  );
  if (state.log.length > 800) state.log.splice(0, state.log.length - 800);
  state.lastReport = report;

  return report;
}
