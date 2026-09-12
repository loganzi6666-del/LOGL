/**
 * Wars, alliances and peace.
 *
 * Warscore is computed from what is actually held on the map, so a peace demand
 * is only as strong as the ground behind it. That keeps negotiation honest: the
 * AI cannot be talked into surrendering territory it has not lost.
 */

import { DIPLOMACY, POLITICS, provinceValue } from './rules.js';
import { adjustRelation, areAllied, areAtWar, getRelation, provincesOf } from './state.js';

let warCounter = 0;

export function nextWarId(state) {
  warCounter = Math.max(warCounter, state.wars.length);
  warCounter += 1;
  return `w${state.meta.turn}-${warCounter}`;
}

export function findWar(state, a, b) {
  return state.wars.find(
    (war) =>
      (war.attackers.includes(a) && war.defenders.includes(b)) ||
      (war.attackers.includes(b) && war.defenders.includes(a)),
  );
}

export function sideOf(war, iso2) {
  if (war.attackers.includes(iso2)) return 'attackers';
  if (war.defenders.includes(iso2)) return 'defenders';
  return null;
}

export function opposingSide(war, iso2) {
  const side = sideOf(war, iso2);
  if (!side) return [];
  return side === 'attackers' ? war.defenders : war.attackers;
}

/**
 * Total worth of everything a side owns, and how much of it the other side is
 * currently sitting on. Warscore is the difference, as a percentage.
 */
function sideHoldings(state, world, side, opponents) {
  let owned = 0;
  let lost = 0;
  for (const iso2 of side) {
    for (const id of provincesOf(state, iso2)) {
      const value = provinceValue(world.province(id), state);
      owned += value;
      if (opponents.includes(state.provinces[id].controller)) lost += value;
    }
  }
  return { owned, lost };
}

export function computeWarScore(state, world, war) {
  const attackerHoldings = sideHoldings(state, world, war.attackers, war.defenders);
  const defenderHoldings = sideHoldings(state, world, war.defenders, war.attackers);

  const attackerGain =
    defenderHoldings.owned > 0 ? (defenderHoldings.lost / defenderHoldings.owned) * 100 : 0;
  const defenderGain =
    attackerHoldings.owned > 0 ? (attackerHoldings.lost / attackerHoldings.owned) * 100 : 0;

  const battleScore = Math.max(-20, Math.min(20, (war.battlesWon ?? 0) - (war.battlesLost ?? 0)));
  const score = Math.max(-100, Math.min(100, attackerGain - defenderGain + battleScore));

  war.warScore = Number(score.toFixed(1));
  war.attackerOccupied = Number(attackerGain.toFixed(1));
  war.defenderOccupied = Number(defenderGain.toFixed(1));
  return war.warScore;
}

/** Warscore from one nation's point of view: positive means it is winning. */
export function scoreFor(war, iso2) {
  const side = sideOf(war, iso2);
  if (!side) return 0;
  return side === 'attackers' ? war.warScore : -war.warScore;
}

export function declareWar(state, world, aggressor, defender, { casusBelli = null, warGoal = null } = {}) {
  if (aggressor === defender) return { ok: false, reason: '자국에 선전포고할 수 없습니다.' };
  if (!state.nations[aggressor]?.alive) return { ok: false, reason: '존재하지 않는 국가입니다.' };
  if (!state.nations[defender]?.alive) return { ok: false, reason: '존재하지 않는 국가입니다.' };
  if (areAtWar(state, aggressor, defender)) return { ok: false, reason: '이미 전쟁 중입니다.' };

  const truceUntil = state.nations[aggressor].truces?.[defender];
  if (truceUntil && truceUntil > state.meta.turn) {
    return {
      ok: false,
      reason: `${state.nations[defender].nameKo}과(와)의 정전 협정이 ${truceUntil - state.meta.turn}턴 남았습니다.`,
    };
  }

  const war = {
    id: nextWarId(state),
    attackers: [aggressor],
    defenders: [defender],
    leadAttacker: aggressor,
    leadDefender: defender,
    startTurn: state.meta.turn,
    casusBelli,
    warGoal,
    warScore: 0,
    battlesWon: 0,
    battlesLost: 0,
  };
  state.wars.push(war);

  linkWar(state, aggressor, defender);

  // Everyone who liked the victim thinks worse of the aggressor.
  for (const other of Object.values(state.nations)) {
    if (!other.alive || other.iso2 === aggressor) continue;
    const sympathy = getRelation(state, other.iso2, defender);
    if (sympathy > 20) {
      adjustRelation(state, other.iso2, aggressor, -(DIPLOMACY.AGGRESSION_PENALTY * (sympathy / 100)));
    }
  }
  adjustRelation(state, aggressor, defender, -60);

  return { ok: true, war };
}

function linkWar(state, a, b) {
  const na = state.nations[a];
  const nb = state.nations[b];
  if (!na.atWarWith.includes(b)) na.atWarWith.push(b);
  if (!nb.atWarWith.includes(a)) nb.atWarWith.push(a);
  na.allies = na.allies.filter((x) => x !== b);
  nb.allies = nb.allies.filter((x) => x !== a);
}

/**
 * Alliance obligations. A defensive pact is only worth anything if the ally
 * honours it — and an ally that is already fighting for its life, or that barely
 * likes you, may not.
 */
export function callAllies(state, world, war, rng, events) {
  const joined = [];

  for (const [sideName, side] of [
    ['defenders', war.defenders],
    ['attackers', war.attackers],
  ]) {
    const lead = sideName === 'defenders' ? war.leadDefender : war.leadAttacker;
    const leadNation = state.nations[lead];
    if (!leadNation) continue;

    for (const ally of [...leadNation.allies]) {
      const nation = state.nations[ally];
      if (!nation?.alive || side.includes(ally)) continue;
      if (war.attackers.includes(ally) || war.defenders.includes(ally)) continue;

      const relation = getRelation(state, ally, lead);
      // Defenders are called in readily; joining an offensive war is a much
      // harder sell.
      const base = sideName === 'defenders' ? 0.55 : 0.15;
      const willingness =
        base + relation / 250 - nation.atWarWith.length * 0.15 - nation.warExhaustion / 200;

      if (!rng.chance(Math.max(0, Math.min(0.95, willingness)))) continue;

      side.push(ally);
      for (const enemy of sideName === 'defenders' ? war.attackers : war.defenders) {
        linkWar(state, ally, enemy);
      }
      joined.push(ally);
      events.push({
        kind: 'diplomacy',
        nation: ally,
        text: `${nation.nameKo}이(가) 동맹 의무에 따라 ${leadNation.nameKo} 편으로 참전했습니다.`,
      });
    }
  }
  return joined;
}

/**
 * What a peace demand is worth, as a share of the loser's total holdings.
 * A demand worth more than the winner's warscore will be refused.
 */
export function priceOfTerms(state, world, war, terms, loserSide) {
  let totalValue = 0;
  for (const iso2 of loserSide) {
    for (const id of provincesOf(state, iso2)) {
      totalValue += provinceValue(world.province(id), state);
    }
  }
  if (totalValue <= 0) return 0;

  let demanded = 0;
  for (const id of terms.annex ?? []) {
    const province = world.province(id);
    if (!province) continue;
    if (!loserSide.includes(state.provinces[id].owner)) continue;
    demanded += provinceValue(province, state);
  }

  let price = (demanded / totalValue) * 100;
  price += (terms.reparations ?? 0) * 0.4;
  if (terms.puppet) price += 60;
  return Number(price.toFixed(1));
}

/**
 * Would this side accept? A nation that is losing badly, exhausted and short of
 * political support will sign almost anything; one that is merely losing will
 * not hand over its heartland.
 */
export function evaluatePeaceOffer(state, world, war, { proposer, terms }) {
  const side = sideOf(war, proposer);
  if (!side) return { accept: false, reason: '해당 전쟁의 당사국이 아닙니다.' };

  const loserSide = side === 'attackers' ? war.defenders : war.attackers;
  const responder = side === 'attackers' ? war.leadDefender : war.leadAttacker;
  const responderNation = state.nations[responder];
  if (!responderNation) return { accept: false, reason: '상대국이 존재하지 않습니다.' };

  const score = scoreFor(war, proposer);
  const price = priceOfTerms(state, world, war, terms, loserSide);

  if (terms.whitePeace) {
    // A white peace is accepted when neither side is clearly winning, or when
    // the responder is the one who is behind.
    const accept = score >= -15 && (scoreFor(war, responder) < 20 || responderNation.warExhaustion > 45);
    return {
      accept,
      price: 0,
      score,
      reason: accept ? '백지 강화 수용' : '아직 유리하다고 판단하여 거부',
    };
  }

  // Desperation makes a government concede beyond what the front line justifies.
  const desperation =
    responderNation.warExhaustion * 0.5 +
    Math.max(0, POLITICS.COLLAPSE_SUPPORT - responderNation.warSupport) * 1.5 +
    Math.max(0, POLITICS.CRISIS_STABILITY - responderNation.stability) * 0.8;

  const threshold = price * 1.15 - desperation;
  const accept = score >= Math.max(DIPLOMACY.NEGOTIATION_FLOOR, threshold);

  return {
    accept,
    price,
    score: Number(score.toFixed(1)),
    threshold: Number(threshold.toFixed(1)),
    reason: accept
      ? '전황과 국내 사정을 고려해 수용'
      : `요구가 과도함 (전쟁점수 ${score.toFixed(0)} < 필요 ${Math.max(DIPLOMACY.NEGOTIATION_FLOOR, threshold).toFixed(0)})`,
  };
}

/** Sign it. Territory changes owner here — this is the only place it does. */
export function applyPeace(state, world, war, { proposer, terms }, events) {
  const side = sideOf(war, proposer);
  const loserSide = side === 'attackers' ? war.defenders : war.attackers;
  const winnerSide = side === 'attackers' ? war.attackers : war.defenders;
  const transferred = [];

  if (!terms.whitePeace) {
    for (const id of terms.annex ?? []) {
      const runtime = state.provinces[id];
      if (!runtime) continue;
      if (!loserSide.includes(runtime.owner)) continue;
      const previousOwner = runtime.owner;
      runtime.owner = proposer;
      runtime.controller = proposer;
      runtime.frontProgress = 0;
      // Land taken from its rightful owner stays restive for a long time.
      runtime.unrest = Math.min(100, runtime.unrest + (runtime.coreOwner === proposer ? 5 : 35));
      transferred.push({ id, from: previousOwner, to: proposer });
    }

    const reparations = terms.reparations ?? 0;
    if (reparations > 0) {
      const payer = state.nations[side === 'attackers' ? war.leadDefender : war.leadAttacker];
      const payee = state.nations[proposer];
      const actual = Math.min(reparations, Math.max(0, payer.treasury));
      payer.treasury -= actual;
      payee.treasury += actual;
    }
  }

  // Everyone goes home, and nobody may restart this war for a while.
  for (const a of winnerSide) {
    for (const b of loserSide) {
      const na = state.nations[a];
      const nb = state.nations[b];
      if (!na || !nb) continue;
      na.atWarWith = na.atWarWith.filter((x) => x !== b);
      nb.atWarWith = nb.atWarWith.filter((x) => x !== a);
      na.truces[b] = state.meta.turn + DIPLOMACY.TRUCE_TURNS;
      nb.truces[a] = state.meta.turn + DIPLOMACY.TRUCE_TURNS;
      adjustRelation(state, a, b, 15);
    }
  }

  // Occupied land that was not annexed goes back to its owner.
  for (const runtime of Object.values(state.provinces)) {
    const occupierInWar =
      winnerSide.includes(runtime.controller) || loserSide.includes(runtime.controller);
    const ownerInWar = winnerSide.includes(runtime.owner) || loserSide.includes(runtime.owner);
    if (occupierInWar && ownerInWar && runtime.controller !== runtime.owner) {
      runtime.controller = runtime.owner;
      runtime.frontProgress = 0;
    }
  }

  state.wars = state.wars.filter((w) => w.id !== war.id);

  const winnerName = state.nations[proposer].nameKo;
  const loserName = state.nations[side === 'attackers' ? war.leadDefender : war.leadAttacker].nameKo;
  events.push({
    kind: 'peace',
    nation: proposer,
    target: side === 'attackers' ? war.leadDefender : war.leadAttacker,
    transferred,
    text: terms.whitePeace
      ? `${winnerName}과(와) ${loserName}이(가) 백지 강화에 합의했습니다.`
      : `${winnerName}과(와) ${loserName}이(가) 강화 조약을 체결했습니다. ` +
        (transferred.length
          ? `${transferred.length}개 주가 ${winnerName}에 할양되었습니다.`
          : '영토 변경은 없습니다.'),
  });

  return { transferred };
}

/** A nation with nothing left surrenders everything it still nominally owns. */
export function checkAnnihilation(state, world, events) {
  for (const nation of Object.values(state.nations)) {
    if (!nation.alive) continue;
    const owned = provincesOf(state, nation.iso2);
    if (owned.length > 0) continue;

    nation.alive = false;
    nation.atWarWith = [];
    for (const other of Object.values(state.nations)) {
      other.atWarWith = other.atWarWith.filter((x) => x !== nation.iso2);
      other.allies = other.allies.filter((x) => x !== nation.iso2);
    }
    state.wars = state.wars.filter(
      (war) => !(war.attackers.includes(nation.iso2) || war.defenders.includes(nation.iso2)),
    );
    events.push({
      kind: 'collapse',
      nation: nation.iso2,
      text: `${nation.nameKo}이(가) 국가로서 소멸했습니다.`,
    });
  }
}

/** Relations creep back towards where the structural facts put them. */
export function driftRelations(state) {
  for (const [key, value] of Object.entries(state.relations)) {
    const [a, b] = key.split('|');
    if (areAtWar(state, a, b)) continue;
    const natural = areAllied(state, a, b) ? 60 : 0;
    const drift = Math.sign(natural - value) * Math.min(POLITICS.RELATION_DRIFT, Math.abs(natural - value));
    state.relations[key] = Number((value + drift).toFixed(1));
  }
}
