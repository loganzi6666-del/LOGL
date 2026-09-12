/**
 * The monthly budget, the home front, and everything that recovers or rots
 * while the armies are busy.
 */

import { ECONOMY, MILITARY, POLITICS, TROOPS_PER_DIVISION } from './rules.js';
import { placeForce } from './military.js';
import { provincesOf, recomputeNation } from './state.js';

/** Money in and money out for one nation, one month. */
export function settleBudget(state, world, nation, events) {
  const income = (nation.gdp * nation.defenceShare) / 12;

  // `occupationCost` is the annual output cost of garrisoning captured ground;
  // it is computed once per turn in recomputeAll.
  const occupationCost = ((nation.occupationCost ?? 0) * nation.defenceShare) ;
  const upkeep = nation.divisions * nation.upkeepPerDivision + occupationCost;

  nation.income = Number(income.toFixed(3));
  nation.expenses = Number(upkeep.toFixed(3));
  nation.treasury = Number((nation.treasury + income - upkeep).toFixed(3));

  // A bankrupt state cannot pay its soldiers: they desert.
  const debtFloor = -income * ECONOMY.DEBT_FLOOR_MONTHS;
  if (nation.treasury < debtFloor) {
    const shortfall = debtFloor - nation.treasury;
    const desertionRate = Math.min(0.25, shortfall / Math.max(1, upkeep) * 0.3);
    let deserted = 0;
    for (const army of Object.values(state.armies)) {
      if (army.owner !== nation.iso2) continue;
      const lost = army.strength * desertionRate;
      army.strength = Number(Math.max(0, army.strength - lost).toFixed(3));
      army.morale = Math.max(0.15, army.morale - 0.1);
      deserted += lost;
    }
    nation.treasury = debtFloor;
    nation.stability = Math.max(0, nation.stability - 4);
    if (deserted > 0.5) {
      events.push({
        kind: 'economy',
        nation: nation.iso2,
        text: `${nation.nameKo}: 재정 파탄으로 ${Math.round(deserted * TROOPS_PER_DIVISION).toLocaleString('ko-KR')}명이 이탈했습니다.`,
      });
    }
  }
}

/**
 * Raise new formations. Limited by money, by manpower, and by how fast a
 * country can realistically expand its army.
 */
export function recruit(state, world, nation, requested, events) {
  if (!(requested > 0)) return { ok: false, reason: '병력 규모를 지정해야 합니다.' };

  const costPerDivision = nation.upkeepPerDivision * ECONOMY.BUILD_COST_MONTHS;
  const manpowerPerDivision = TROOPS_PER_DIVISION;

  const affordable = costPerDivision > 0 ? nation.treasury / costPerDivision : 0;
  const available = nation.manpower / manpowerPerDivision;
  const maxRate = Math.max(1, nation.divisions * ECONOMY.MAX_BUILD_RATE);

  const actual = Math.max(0, Math.min(requested, affordable, available, maxRate));
  if (actual < 0.05) {
    const blocker =
      affordable < 0.05 ? '예산 부족' : available < 0.05 ? '인력 부족' : '동원 한계';
    return { ok: false, reason: `${blocker}으로 증강할 수 없습니다.` };
  }

  nation.treasury = Number((nation.treasury - actual * costPerDivision).toFixed(3));
  nation.manpower = Math.round(nation.manpower - actual * manpowerPerDivision);

  // New formations appear at the capital, or wherever the government still sits.
  const home =
    (nation.capitalProvince && state.provinces[nation.capitalProvince]?.controller === nation.iso2
      ? nation.capitalProvince
      : provincesOf(state, nation.iso2, { controlled: true })[0]) ?? null;
  if (!home) return { ok: false, reason: '병력을 편성할 영토가 없습니다.' };

  placeForce(state, home, nation.iso2, { strength: actual, morale: 0.7, supply: 1 });
  recomputeNation(state, world, nation.iso2);

  events.push({
    kind: 'military',
    nation: nation.iso2,
    text: `${nation.nameKo}: ${actual.toFixed(1)}개 사단(${Math.round(actual * TROOPS_PER_DIVISION).toLocaleString('ko-KR')}명)을 신규 편성했습니다.`,
  });
  return { ok: true, divisions: Number(actual.toFixed(2)), cost: actual * costPerDivision };
}

/** Reinforce existing formations back towards full strength and morale. */
export function reinforce(state, nation, budget) {
  const understrength = Object.values(state.armies).filter(
    (army) => army.owner === nation.iso2 && army.morale < 1,
  );
  if (!understrength.length || budget <= 0) return 0;
  const spend = Math.min(budget, nation.treasury);
  if (spend <= 0) return 0;
  nation.treasury = Number((nation.treasury - spend).toFixed(3));
  const boost = Math.min(0.2, spend / Math.max(1, nation.divisions * nation.upkeepPerDivision * 3));
  for (const army of understrength) {
    army.morale = Math.min(1, army.morale + boost);
  }
  return spend;
}

/** Money spent on fortifications, industry or research. */
export function invest(state, world, nation, { target, amount, province = null }, events) {
  const spend = Math.min(amount, nation.treasury);
  if (!(spend > 0)) return { ok: false, reason: '재정이 부족합니다.' };

  if (target === 'fortify') {
    const id = province ?? nation.capitalProvince;
    const runtime = state.provinces[id];
    if (!runtime || runtime.controller !== nation.iso2) {
      return { ok: false, reason: '통제하지 않는 지역은 요새화할 수 없습니다.' };
    }
    const costPerLevel = Math.max(0.5, runtime.baseOutput * 0.35);
    const levels = Math.min(5 - runtime.fortLevel, Math.floor(spend / costPerLevel));
    if (levels < 1) {
      return { ok: false, reason: `요새화에 최소 ${costPerLevel.toFixed(1)}B USD가 필요합니다.` };
    }
    nation.treasury = Number((nation.treasury - levels * costPerLevel).toFixed(3));
    runtime.fortLevel += levels;
    events.push({
      kind: 'economy',
      nation: nation.iso2,
      province: id,
      text: `${world.province(id).name} 요새 수준이 ${runtime.fortLevel}로 올라갔습니다.`,
    });
    return { ok: true, spent: levels * costPerLevel };
  }

  if (target === 'research') {
    const costPerLevel = nation.gdp * 0.02 * nation.tech;
    if (spend < costPerLevel) {
      return { ok: false, reason: `기술 향상에 ${costPerLevel.toFixed(1)}B USD가 필요합니다.` };
    }
    nation.treasury = Number((nation.treasury - costPerLevel).toFixed(3));
    nation.tech = Math.min(10, nation.tech + 1);
    events.push({
      kind: 'economy',
      nation: nation.iso2,
      text: `${nation.nameKo}의 군사 기술 수준이 ${nation.tech}로 향상되었습니다.`,
    });
    return { ok: true, spent: costPerLevel };
  }

  if (target === 'economy' || target === 'infrastructure') {
    // Investment raises the long-run output of the provinces you actually hold.
    nation.treasury = Number((nation.treasury - spend).toFixed(3));
    const held = provincesOf(state, nation.iso2, { controlled: true });
    const gain = spend * 0.6;
    const totalOutput = held.reduce((sum, id) => sum + state.provinces[id].baseOutput, 0) || 1;
    for (const id of held) {
      const runtime = state.provinces[id];
      runtime.baseOutput = Number(
        (runtime.baseOutput + gain * (runtime.baseOutput / totalOutput)).toFixed(4),
      );
    }
    nation.stability = Math.min(100, nation.stability + spend / Math.max(1, nation.gdp * 0.004));
    events.push({
      kind: 'economy',
      nation: nation.iso2,
      text: `${nation.nameKo}이(가) ${spend.toFixed(1)}B USD를 경제에 투자했습니다.`,
    });
    return { ok: true, spent: spend };
  }

  return { ok: false, reason: `알 수 없는 투자 항목: ${target}` };
}

/** Provinces heal, occupied ones seethe, and manpower slowly comes back. */
export function tickHomeFront(state, world, nation) {
  const atWar = nation.atWarWith.length > 0;

  // Manpower regenerates from population, faster in peace.
  nation.manpowerMax = Math.round(nation.population * MILITARY.MANPOWER_POOL);
  const regen = nation.manpowerMax * MILITARY.MANPOWER_REGEN * (atWar ? 1.6 : 1);
  nation.manpower = Math.min(nation.manpowerMax, Math.round(nation.manpower + regen));

  // War exhaustion builds while fighting and bleeds off in peace.
  if (atWar) {
    const casualties = nation.monthlyCasualties ?? 0;
    nation.warExhaustion = Math.min(
      100,
      nation.warExhaustion + POLITICS.WAR_WEARINESS + casualties / 40_000,
    );
    nation.warSupport = Math.max(
      0,
      nation.warSupport - POLITICS.WAR_WEARINESS - (casualties / 100_000) * POLITICS.STABILITY_PER_CASUALTY,
    );
  } else {
    nation.warExhaustion = Math.max(0, nation.warExhaustion - 2.5);
    nation.warSupport = Math.min(100, nation.warSupport + 1.5);
  }

  // Occupied homeland is a standing humiliation.
  if (nation.occupiedByEnemy > 0) {
    nation.stability = Math.max(
      0,
      nation.stability - POLITICS.OCCUPIED_HOME_PENALTY * Math.min(4, nation.occupiedByEnemy),
    );
  } else if (!atWar) {
    nation.stability = Math.min(100, nation.stability + 0.8);
  }

  nation.stability = Math.max(
    0,
    Math.min(100, nation.stability - (nation.monthlyCasualties ?? 0) / 200_000),
  );
  nation.monthlyCasualties = 0;
}

/** Land recovers from fighting; occupied land grows restless. */
export function tickProvinces(state, world, rng, events) {
  for (const [id, province] of Object.entries(state.provinces)) {
    if (province.devastation > 0) {
      province.devastation = Math.max(
        0,
        Number((province.devastation - ECONOMY.DEVASTATION_RECOVERY).toFixed(3)),
      );
    }

    const occupied = province.controller !== province.owner;
    if (occupied) {
      const hostile = province.coreOwner !== province.controller;
      province.unrest = Math.min(
        100,
        province.unrest + (hostile ? ECONOMY.OCCUPATION_UNREST : ECONOMY.OCCUPATION_UNREST * 0.3),
      );
    } else {
      province.unrest = Math.max(0, province.unrest - ECONOMY.UNREST_DECAY);
    }

    // An occupation that is hated enough eventually throws the occupier out.
    if (province.unrest >= 85 && occupied && rng.chance(0.06)) {
      const liberator = province.owner;
      if (state.nations[liberator]?.alive) {
        province.controller = liberator;
        province.unrest = 40;
        province.frontProgress = 0;
        events.push({
          kind: 'revolt',
          nation: liberator,
          province: id,
          text: `${world.province(id).name}에서 봉기가 일어나 점령군이 축출되었습니다.`,
        });
      }
    }
  }
}
