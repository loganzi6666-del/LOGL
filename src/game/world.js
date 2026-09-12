/**
 * Loads and indexes the static world — the geography that never changes during
 * a game. Ownership, armies and everything else that moves lives in the game
 * state; this module only answers questions about the map itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORLD_PATH = path.resolve(here, '../../data/world.json');

let cached = null;

/** Straight-line distance in km between two [lon, lat] points. */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function loadWorld({ force = false } = {}) {
  if (cached && !force) return cached;

  if (!fs.existsSync(WORLD_PATH)) {
    throw new Error(
      `지도 데이터가 없습니다: ${WORLD_PATH}\n먼저 "npm run build:world"를 실행하세요.`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(WORLD_PATH, 'utf8'));
  const provinces = new Map(raw.provinces.map((p) => [p.id, p]));
  const nations = new Map(Object.entries(raw.nations));

  // Provinces grouped by the nation that historically owns them.
  const byCore = new Map();
  for (const province of raw.provinces) {
    let list = byCore.get(province.coreOwner);
    if (!list) {
      list = [];
      byCore.set(province.coreOwner, list);
    }
    list.push(province.id);
  }

  const coastal = raw.provinces.filter((p) => p.coastal);

  cached = {
    generatedAt: raw.generatedAt,
    source: raw.source,
    provinceList: raw.provinces,
    provinces,
    nations,
    byCore,
    coastal,

    province: (id) => provinces.get(id),
    nation: (iso2) => nations.get(iso2),

    /** Provinces sharing a land border with this one. */
    neighbours: (id) => provinces.get(id)?.neighbours ?? [],

    /**
     * Coastal provinces within naval striking distance. Amphibious operations
     * use this instead of land adjacency, which is what makes island nations
     * reachable at all.
     */
    withinSeaRange(id, rangeKm) {
      const origin = provinces.get(id);
      if (!origin?.coastal) return [];
      const result = [];
      for (const candidate of coastal) {
        if (candidate.id === id) continue;
        const distance = distanceKm(origin.centre, candidate.centre);
        if (distance <= rangeKm) result.push({ id: candidate.id, distance });
      }
      result.sort((a, b) => a.distance - b.distance);
      return result;
    },

    /** Great-circle distance between two provinces' centres, in km. */
    distance(a, b) {
      const pa = provinces.get(a);
      const pb = provinces.get(b);
      if (!pa || !pb) return Infinity;
      return distanceKm(pa.centre, pb.centre);
    },
  };

  return cached;
}

/**
 * Shortest land path between two provinces, walking only through provinces the
 * filter accepts. Used for supply lines and for checking whether an army can
 * actually reach where it has been ordered.
 */
export function findLandPath(world, from, to, canEnter = () => true) {
  if (from === to) return [from];
  const queue = [from];
  const cameFrom = new Map([[from, null]]);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const next of world.neighbours(current)) {
      if (cameFrom.has(next)) continue;
      if (next !== to && !canEnter(next)) continue;
      cameFrom.set(next, current);
      if (next === to) {
        const path = [next];
        let step = current;
        while (step !== null) {
          path.push(step);
          step = cameFrom.get(step);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}
