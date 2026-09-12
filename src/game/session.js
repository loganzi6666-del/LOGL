/**
 * A playthrough: the state, the turn loop, and saving.
 *
 * The turn loop is where the two halves meet. The language model reads the
 * player's instruction and every AI nation's situation and decides what each
 * one attempts; `resolveTurn` then decides what actually happens. The narrator
 * only ever describes the result.
 */

import fs from 'node:fs';
import path from 'node:path';

import { config, ensureSavesDir, hasCredentials } from '../config.js';
import { Rng } from './rng.js';
import { loadWorld } from './world.js';
import { newGame, recomputeAll, SAVE_VERSION } from './state.js';
import { resolveTurn, formatDate } from './engine.js';
import { validateOrders } from './orders.js';
import { interpretCommand, retryRejected } from '../ai/arbiter.js';
import { parseCommand } from '../ai/localCommand.js';
import { planAiTurn } from '../ai/nation.js';
import { localSummary, narrateTurn } from '../ai/narrator.js';
import { heuristicOrders } from '../ai/heuristic.js';

const SAVE_NAME = /^[\w-]{1,64}$/;

export class Session {
  constructor(state) {
    this.world = loadWorld();
    this.state = state;
    recomputeAll(this.state, this.world);
    /** Set while a turn is resolving, so two clicks cannot run it twice. */
    this.busy = false;
    this.lastNarration = null;
    this.lastDecisions = [];
  }

  static create({ playerNation = 'KR', seed = null, startYear = 2025 } = {}) {
    return new Session(newGame({ playerNation, seed, startYear }));
  }

  static load(name) {
    if (!SAVE_NAME.test(name)) throw new Error('저장 이름이 올바르지 않습니다.');
    const file = path.join(ensureSavesDir(), `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`저장 파일을 찾을 수 없습니다: ${name}`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.meta?.version !== SAVE_VERSION) {
      throw new Error(
        `저장 파일 버전이 맞지 않습니다 (파일 ${saved.meta?.version}, 현재 ${SAVE_VERSION}).`,
      );
    }
    const session = new Session(saved);
    session.lastNarration = saved.lastNarration ?? null;
    return session;
  }

  static list() {
    const dir = ensureSavesDir();
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          return {
            name: file.replace(/\.json$/, ''),
            nation: saved.meta?.playerNation,
            nationName: saved.nations?.[saved.meta?.playerNation]?.nameKo,
            turn: saved.meta?.turn,
            date: `${saved.meta?.year}년 ${saved.meta?.month}월`,
            savedAt: saved.meta?.savedAt ?? null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  save(name) {
    if (!SAVE_NAME.test(name)) throw new Error('저장 이름은 영문/숫자/-/_만 사용할 수 있습니다.');
    const dir = ensureSavesDir();
    this.state.meta.savedAt = new Date().toISOString();
    const payload = { ...this.state, lastNarration: this.lastNarration };
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(payload));
    return { name, savedAt: this.state.meta.savedAt };
  }

  get player() {
    return this.state.nations[this.state.meta.playerNation];
  }

  /**
   * Read a player instruction without committing to it. Returns the orders the
   * arbiter produced, what it refused and why, and its reply — so the player can
   * see what is about to happen before the month runs.
   */
  async interpret(instruction, { selectedProvince = null } = {}) {
    // No key, no problem: the local parser understands the common Korean orders
    // instantly and for nothing. It is also the safety net when a paid call fails.
    if (!hasCredentials()) {
      return parseCommand(this.state, this.world, instruction, { selectedProvince });
    }

    let result;
    try {
      result = await interpretCommand(this.state, this.world, instruction);
    } catch (error) {
      const local = parseCommand(this.state, this.world, instruction, { selectedProvince });
      return {
        ...local,
        reply: `AI 호출에 실패해 내장 해석기로 처리했습니다 (${error.message}).\n${local.reply}`,
      };
    }

    // One corrective pass: the rejection reasons are specific enough to act on.
    if (result.rejected.length && !result.isQuestion) {
      const retry = await retryRejected(this.state, this.world, instruction, result.rejected);
      if (retry.orders.length) {
        result = {
          ...result,
          orders: [...result.orders, ...retry.orders],
          rejected: retry.rejected,
          reply: retry.reply || result.reply,
        };
      }
    }
    return result;
  }

  /**
   * Run one month.
   *
   * @param {object} options
   * @param {object[]} [options.orders] the player's orders, already validated
   * @param {string}  [options.instruction] what the player typed, for the record
   * @param {boolean} [options.useLlm] let AI nations think; false runs rules only
   */
  async advanceTurn({ orders = [], instruction = null, useLlm = hasCredentials() } = {}) {
    if (this.busy) throw new Error('이미 턴을 처리하는 중입니다.');
    this.busy = true;

    try {
      const player = this.state.meta.playerNation;
      const { accepted, rejected } = validateOrders(this.state, this.world, player, orders);

      // AI nations plan against the world as it stands before anyone moves.
      const rng = Rng.fromJSON(this.state.meta.rngState);
      let decisions = [];
      let aiOrders = {};

      if (useLlm) {
        const planned = await planAiTurn(this.state, this.world, rng, { useLlm: true });
        aiOrders = planned.orders;
        decisions = planned.decisions;
      } else {
        for (const nation of Object.values(this.state.nations)) {
          if (!nation.alive || nation.iso2 === player) continue;
          const raw = heuristicOrders(this.state, this.world, nation.iso2, rng);
          if (!raw.length) continue;
          const validated = validateOrders(this.state, this.world, nation.iso2, raw);
          if (validated.accepted.length) aiOrders[nation.iso2] = validated.accepted;
        }
      }
      this.state.meta.rngState = rng.toJSON();

      const allOrders = { ...aiOrders };
      if (accepted.length) allOrders[player] = accepted;

      const report = resolveTurn(this.state, this.world, allOrders);
      report.playerRejected = rejected;
      report.aiDecisions = decisions.map((decision) => ({
        nation: decision.iso2,
        nationName: this.state.nations[decision.iso2]?.nameKo,
        source: decision.source,
        assessment: decision.assessment ?? null,
        intent: decision.intent ?? null,
        orders: decision.orders?.length ?? 0,
        error: decision.error ?? null,
      }));

      // And the write-up.
      let narration;
      if (useLlm) {
        try {
          narration = await narrateTurn(this.state, this.world, report, {
            playerDecision: instruction,
          });
        } catch (error) {
          narration = { ...localSummary(this.state, this.world, report), error: String(error?.message ?? error) };
        }
      } else {
        narration = localSummary(this.state, this.world, report);
      }

      this.lastNarration = narration;
      this.lastDecisions = decisions;
      return { report, narration };
    } finally {
      this.busy = false;
    }
  }

  /** Everything the client needs to draw the world. */
  snapshot() {
    const provinces = {};
    for (const [id, province] of Object.entries(this.state.provinces)) {
      provinces[id] = {
        o: province.owner,
        c: province.controller,
        d: Math.round(province.devastation * 100),
        u: Math.round(province.unrest),
        f: province.fortLevel,
        p: Math.round(province.frontProgress),
      };
    }

    const nations = {};
    for (const [iso2, nation] of Object.entries(this.state.nations)) {
      if (!nation.alive) continue;
      nations[iso2] = {
        iso2,
        name: nation.nameKo,
        nameEn: nation.name,
        gdp: nation.gdp,
        population: nation.population,
        divisions: nation.divisions,
        troops: nation.troops,
        quality: nation.quality,
        tech: nation.tech,
        nukes: nation.nukes,
        stability: Math.round(nation.stability),
        warSupport: Math.round(nation.warSupport),
        atWarWith: nation.atWarWith,
        allies: nation.allies,
        provinces: nation.controlledProvinces,
        isPlayer: nation.isPlayer,
      };
    }

    const armies = Object.values(this.state.armies)
      .filter((army) => army.strength >= 0.5)
      .map((army) => ({
        id: army.id,
        owner: army.owner,
        province: army.province,
        strength: Number(army.strength.toFixed(1)),
        morale: Number(army.morale.toFixed(2)),
        supply: Number(army.supply.toFixed(2)),
      }));

    return {
      meta: {
        ...this.state.meta,
        date: formatDate(this.state),
        provider: config.provider,
        aiEnabled: hasCredentials(),
      },
      player: this.playerDetail(),
      nations,
      provinces,
      armies,
      wars: this.state.wars,
      relations: this.playerRelations(),
      narration: this.lastNarration,
      log: this.state.log.slice(-60),
    };
  }

  playerDetail() {
    const nation = this.player;
    return {
      ...nation,
      name: nation.nameKo,
      nameEn: nation.name,
      dateLabel: formatDate(this.state),
      upkeep: Number((nation.divisions * nation.upkeepPerDivision).toFixed(2)),
      recruitCost: Number((nation.upkeepPerDivision * 30).toFixed(3)),
    };
  }

  playerRelations() {
    const player = this.state.meta.playerNation;
    const out = {};
    for (const [key, value] of Object.entries(this.state.relations)) {
      const [a, b] = key.split('|');
      if (a === player) out[b] = value;
      else if (b === player) out[a] = value;
    }
    return out;
  }
}
