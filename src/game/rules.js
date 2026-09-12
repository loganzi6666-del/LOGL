/**
 * Balance constants and the formulas that turn real-world figures into game
 * numbers.
 *
 * The guiding idea: derive as much as possible from the seed data instead of
 * inventing it. A nation's cost per division comes from its actual defence
 * budget divided by its actual army, and equipment quality comes from how much
 * it spends per soldier. That is why a US division costs two hundred times what
 * a North Korean one does, and why North Korea still fields four times as many.
 */

/** One turn is one month. */
export const TURN_MONTHS = 1;

/** Soldiers in a division. Everything military is counted in divisions. */
export const TROOPS_PER_DIVISION = 15_000;

/** Combat power of one division at quality 1.0, full morale and full supply. */
export const BASE_DIVISION_POWER = 100;

export const ECONOMY = {
  /** Share of a province's output that survives while it is under occupation. */
  OCCUPIED_OUTPUT: 0.35,
  /** Monthly cost of garrisoning one occupied province, as a share of its output. */
  OCCUPATION_COST: 0.25,
  /** Devastation recovered per month once the fighting moves on. */
  DEVASTATION_RECOVERY: 0.04,
  /** Unrest that decays per month in a quiet province. */
  UNREST_DECAY: 1.5,
  /** Unrest added each month to an occupied province that is not a core. */
  OCCUPATION_UNREST: 2.5,
  /** Building one division costs this many months of its own upkeep. */
  BUILD_COST_MONTHS: 30,
  /** A division can be raised no faster than this share of the army per month. */
  MAX_BUILD_RATE: 0.06,
  /** Treasury may go this far negative before emergency measures kick in. */
  DEBT_FLOOR_MONTHS: 6,
};

export const MILITARY = {
  /** Share of population that can ever be put under arms. */
  MANPOWER_POOL: 0.05,
  /** Share of the pool that regenerates monthly. */
  MANPOWER_REGEN: 0.012,
  /** Front progress needed to take a province. */
  CAPTURE_THRESHOLD: 100,
  /** Progress per turn at a 1:1 fight is zero; this scales the curve. */
  PROGRESS_SCALE: 26,
  PROGRESS_MIN: -18,
  PROGRESS_MAX: 45,
  /** Attacker needs better than this power ratio to make any headway. */
  STALL_RATIO: 0.8,
  /** Casualty rate per turn of combat, as a share of the opposing force's power. */
  LOSS_RATE: 0.018,
  /** Entrenchment gained per quiet turn, and its cap. */
  ENTRENCH_PER_TURN: 1,
  ENTRENCH_MAX: 10,
  ENTRENCH_BONUS: 0.03,
  /** Each fort level multiplies defence by this much. */
  FORT_BONUS: 0.2,
  /** Dense, built-up ground is much harder to take. */
  URBAN_BONUS: 0.35,
  /** Amphibious assaults land without their heavy equipment. */
  AMPHIBIOUS_PENALTY: 0.55,
  /** How far a naval invasion can reach, in km. */
  NAVAL_RANGE_KM: 1200,
  /** Morale lost per defeat and regained per quiet turn. */
  MORALE_LOSS: 0.08,
  MORALE_REGEN: 0.05,
  /** Attrition per turn for an army that has lost its supply line. */
  UNSUPPLIED_ATTRITION: 0.06,
  /** Supply multiplier applied to combat power when cut off. */
  UNSUPPLIED_POWER: 0.5,
  /** Supply available to a beachhead with no land connection. */
  AMPHIBIOUS_SUPPLY: 0.7,
};

export const POLITICS = {
  /** Stability lost per 100k casualties in a month. */
  STABILITY_PER_CASUALTY: 3.0,
  /** War support lost per month of war, before casualties. */
  WAR_WEARINESS: 0.8,
  /** War support gained for taking an enemy province. */
  SUPPORT_PER_CONQUEST: 4,
  /** Stability lost per month while any home province is occupied. */
  OCCUPIED_HOME_PENALTY: 1.5,
  /** Below this stability, the government starts losing control. */
  CRISIS_STABILITY: 25,
  /** Below this war support, the nation will accept almost any peace. */
  COLLAPSE_SUPPORT: 15,
  /** Monthly drift of relations back towards their natural level. */
  RELATION_DRIFT: 0.5,
};

export const DIPLOMACY = {
  /** Relations range. */
  MIN: -100,
  MAX: 100,
  /** Declaring war on someone costs you this much with everyone who likes them. */
  AGGRESSION_PENALTY: 25,
  /** How long a truce lasts after a peace deal, in turns. */
  TRUCE_TURNS: 36,
  /** Warscore needed before an opponent will even discuss terms. */
  NEGOTIATION_FLOOR: 15,
};

export const NUCLEAR = {
  /** Devastation a single warhead inflicts on a province. */
  DEVASTATION: 0.75,
  /** Share of the province's population killed. */
  CASUALTY_RATE: 0.22,
  /** Relations penalty with every nation on earth, first use. */
  GLOBAL_OUTRAGE: 60,
  /** Chance a nuclear power retaliates in kind when struck. */
  RETALIATION_CHANCE: 0.85,
};

/** Divisions a nation fields, from its real active personnel. */
export function divisionsFromPersonnel(active) {
  return Math.max(0, active / TROOPS_PER_DIVISION);
}

/**
 * Monthly upkeep for one division, in USD billions.
 *
 * Calibrated so that at game start every nation spends roughly 60% of its real
 * defence budget maintaining its real army — the rest is free for procurement,
 * research and operations. That single anchor reproduces the enormous spread in
 * what a soldier costs around the world without inventing a number.
 */
export function upkeepPerDivision({ budget, active, gdp, population }) {
  const divisions = divisionsFromPersonnel(active);
  if (divisions > 0.2 && budget > 0) {
    return (budget * 0.6) / 12 / divisions;
  }
  // No army, or no reported budget: fall back to what this economy would pay.
  const perCapita = population > 0 ? (gdp * 1e9) / population : 5000;
  return Math.max(0.0015, 0.35 * Math.min(1, (perCapita / 60_000) ** 0.6));
}

/**
 * Equipment and training quality, 0.3 to 1.0, from spending per soldier.
 * This is what separates a conscript army from a professional one.
 */
export function qualityFromSpending({ budget, active, gdp, population }) {
  if (!(active > 0) || !(budget > 0)) {
    const perCapita = population > 0 ? (gdp * 1e9) / population : 5000;
    return 0.3 + 0.7 * Math.min(1, (perCapita / 70_000) ** 0.5);
  }
  const perSoldier = (budget * 1e9) / active;
  return 0.3 + 0.7 * Math.min(1, (perSoldier / 400_000) ** 0.45);
}

/** Share of GDP a nation devotes to defence and foreign policy each year. */
export function defenceShareFromSeed({ budget, gdp }) {
  if (!(gdp > 0)) return 0.02;
  return Math.min(0.25, Math.max(0.004, budget / gdp));
}

/** Combat power of a formation. */
export function divisionPower({ quality, morale, supply, techBonus = 0 }) {
  return (
    BASE_DIVISION_POWER *
    quality *
    (0.55 + 0.45 * morale) *
    (MILITARY.UNSUPPLIED_POWER + (1 - MILITARY.UNSUPPLIED_POWER) * supply) *
    (1 + techBonus)
  );
}

/** Attacking across water or difficult ground is costly. */
export function climateAttackModifier(climate) {
  switch (climate) {
    case 'arctic':
      return 0.75;
    case 'boreal':
      return 0.9;
    case 'tropical':
      return 0.88;
    default:
      return 1;
  }
}

/**
 * How much a province is worth in a peace negotiation. Population and economic
 * output matter more than raw area, and a capital is worth a great deal.
 */
export function provinceValue(province, state) {
  const runtime = state.provinces[province.id];
  const isCapital = state.nations[province.coreOwner]?.capitalProvince === province.id;
  const economic = runtime?.baseOutput ?? 0;
  return Math.max(1, province.population / 1e6 + economic * 2 + (isCapital ? 40 : 0));
}
