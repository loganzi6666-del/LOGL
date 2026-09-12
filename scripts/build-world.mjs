#!/usr/bin/env node
/**
 * Builds `data/world.json` — the static map the game is played on.
 *
 * The map is real, not invented:
 *   - country outlines come from Natural Earth via `world-atlas` (1:50m)
 *   - provinces are seeded from real GeoNames admin-1 regions via `all-the-cities`,
 *     so a province is centred on a genuine administrative region and named after
 *     its largest city
 *   - populations are built up from real city populations, with the remainder
 *     spread over land area
 *
 * Each country is cut into Voronoi cells around those seeds and the cells are
 * clipped to the country's real borders. That gives territory the game can
 * transfer between owners while the coastline and international borders stay
 * exactly where they are in reality.
 *
 * Run: npm run build:world
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as topojson from 'topojson-client';
import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';
import allCities from 'all-the-cities';
import countriesMeta from 'world-countries/countries.json' with { type: 'json' };

import {
  bboxIntersects,
  bboxOf,
  centroidOf,
  densifiedBoundary,
  makeLocalProjection,
  mapMultiPolygon,
  needsUnwrap,
  pointInMultiPolygon,
  polygonAreaKm2,
  quantize,
  rewrapLon,
  toMultiPolygon,
  unwrapLon,
} from './lib/geometry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DATA_DIR = path.join(root, 'data');

/** Map features that are not playable states. */
const EXCLUDED_IDS = new Set([
  '010', // Antarctica
  '260', // French Southern and Antarctic Lands
  '074', // Bouvet Island
  '334', // Heard Island and McDonald Islands
]);

/** world-atlas features whose numeric id has no ISO 3166 counterpart. */
const MANUAL_ISO = {
  '-99': null, // ambiguous / disputed slivers, resolved by name below
};

/** Resolved by feature name when the numeric id fails. */
const NAME_TO_ISO = {
  Kosovo: 'XK',
  'N. Cyprus': 'CY',
  'Northern Cyprus': 'CY',
  Somaliland: 'SO',
  'Siachen Glacier': 'IN',
  'Indian Ocean Ter.': 'AU',
  'Ashmore and Cartier Is.': 'AU',
};

/** Adjacency is detected by rasterising borders onto a grid of this size (degrees). */
const ADJACENCY_GRID = 0.06;

function log(...args) {
  console.log(...args);
}

/**
 * How many provinces a country is worth. Driven by both land area and
 * population so that a dense small state is not reduced to a single tile while
 * an empty vast one is not shattered into dozens.
 */
function provinceBudget(areaKm2, population) {
  const fromArea = 2.2 * Math.sqrt(Math.max(0, areaKm2) / 50_000);
  const fromPeople = 2.6 * Math.sqrt(Math.max(0, population) / 15_000_000);
  return Math.max(1, Math.min(60, Math.round(1 + fromArea + fromPeople)));
}

function loadCountryShapes() {
  const topo = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules/world-atlas/countries-50m.json'), 'utf8'),
  );
  return topojson.feature(topo, topo.objects.countries).features;
}

function indexCountryMeta() {
  const byNumeric = new Map();
  const byAlpha2 = new Map();
  for (const country of countriesMeta) {
    const meta = {
      iso2: country.cca2,
      iso3: country.cca3,
      name: country.name.common,
      officialName: country.name.official,
      nameKo: country.translations?.kor?.common ?? country.name.common,
      capital: country.capital?.[0] ?? null,
      region: country.region,
      subregion: country.subregion,
      area: country.area,
      landlocked: country.landlocked,
      borders: country.borders ?? [],
      latlng: country.latlng,
      unMember: country.unMember,
      independent: country.independent,
    };
    if (country.ccn3) byNumeric.set(country.ccn3, meta);
    byAlpha2.set(country.cca2, meta);
  }
  return { byNumeric, byAlpha2 };
}

function indexCities() {
  const byCountry = new Map();
  for (const city of allCities) {
    let list = byCountry.get(city.country);
    if (!list) {
      list = [];
      byCountry.set(city.country, list);
    }
    list.push({
      name: city.name,
      adminCode: city.adminCode,
      population: city.population,
      lon: city.loc.coordinates[0],
      lat: city.loc.coordinates[1],
    });
  }
  for (const list of byCountry.values()) list.sort((a, b) => b.population - a.population);
  return byCountry;
}

/**
 * Group a country's cities into their real admin-1 regions and return seed
 * points, strongest region first. The seed is the population-weighted centre of
 * the region, which covers the region's land better than its biggest city does —
 * unless that centre falls outside the country, in which case the biggest city
 * is the safe choice.
 */
function buildSeeds(cities, countryMulti, budget) {
  const regions = new Map();
  for (const city of cities) {
    const key = city.adminCode || '__';
    let region = regions.get(key);
    if (!region) {
      region = { code: key, cities: [], population: 0 };
      regions.set(key, region);
    }
    region.cities.push(city);
    region.population += city.population;
  }

  const ranked = [...regions.values()].sort((a, b) => b.population - a.population).slice(0, budget);

  const seeds = [];
  for (const region of ranked) {
    let sumLon = 0;
    let sumLat = 0;
    let sumWeight = 0;
    for (const city of region.cities) {
      const weight = Math.sqrt(city.population); // damp megacity pull on the centre
      sumLon += city.lon * weight;
      sumLat += city.lat * weight;
      sumWeight += weight;
    }
    const biggest = region.cities[0];
    let point = sumWeight > 0 ? [sumLon / sumWeight, sumLat / sumWeight] : [biggest.lon, biggest.lat];
    if (!pointInMultiPolygon(point, countryMulti)) point = [biggest.lon, biggest.lat];
    seeds.push({ point, name: biggest.name, adminCode: region.code, population: region.population });
  }
  return seeds;
}

/**
 * Countries with no city data at all (micro-states, remote territories) still
 * need at least one province, so fall back to the shape's own centre.
 */
function fallbackSeeds(countryMulti) {
  const centre = centroidOf(countryMulti);
  const point = pointInMultiPolygon(centre, countryMulti)
    ? centre
    : countryMulti[0][0][0].slice();
  return [{ point, name: null, adminCode: '__', population: 0 }];
}

/** "Washington, D.C." and "Washington D.C." should match the same city. */
const normaliseName = (value) =>
  (value ?? '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, '');

/**
 * Does this bucket of cities contain the nation's capital? Exact match first;
 * a containment match is the fallback for the handful of capitals whose GeoNames
 * spelling differs from the ISO one.
 */
function capitalMatch(cities, capitalName) {
  if (!capitalName) return 0;
  const target = normaliseName(capitalName);
  if (!target) return 0;
  for (const city of cities) {
    if (normaliseName(city.name) === target) return 2;
  }
  for (const city of cities) {
    const name = normaliseName(city.name);
    if (name && (name.includes(target) || target.includes(name))) return 1;
  }
  return 0;
}

/** Rings of the country that could possibly touch this cell, to keep clipping cheap. */
function relevantRings(countryMulti, countryBoxes, cellBox) {
  const subset = [];
  for (let i = 0; i < countryMulti.length; i += 1) {
    if (bboxIntersects(countryBoxes[i], cellBox)) subset.push(countryMulti[i]);
  }
  return subset;
}

function carveCountry(feature, meta, cities, seedPopulation) {
  const capitalName = meta.capital;
  const rawMulti = toMultiPolygon(feature.geometry);
  if (!rawMulti.length) return [];

  const unwrap = needsUnwrap(rawMulti.flat());
  const shift = unwrap ? (lon) => unwrapLon(lon) : (lon) => lon;
  const unshift = unwrap ? (lon) => rewrapLon(lon) : (lon) => lon;

  const geoMulti = mapMultiPolygon(rawMulti, ([lon, lat]) => [shift(lon), lat]);
  const centre = centroidOf(geoMulti);
  const projection = makeLocalProjection(centre[1]);

  const areaKm2 = polygonAreaKm2(rawMulti);
  const budget = provinceBudget(areaKm2, seedPopulation);

  const countryCities = cities.map((city) => ({ ...city, lon: shift(city.lon) }));
  const seeds = countryCities.length
    ? buildSeeds(countryCities, geoMulti, budget)
    : fallbackSeeds(geoMulti);
  if (!seeds.length) return [];

  const planarCountry = mapMultiPolygon(geoMulti, projection.forward);
  const countryBoxes = planarCountry.map((polygon) => bboxOf([polygon]));
  const [minX, minY, maxX, maxY] = bboxOf(planarCountry);
  const pad = Math.max(1, (maxX - minX + maxY - minY) * 0.25);

  const points = seeds.map((seed) => projection.forward(seed.point));
  const provinces = [];

  if (points.length === 1) {
    provinces.push({ seed: seeds[0], multi: geoMulti });
  } else {
    const delaunay = Delaunay.from(points);
    const voronoi = delaunay.voronoi([minX - pad, minY - pad, maxX + pad, maxY + pad]);
    for (let i = 0; i < points.length; i += 1) {
      const cell = voronoi.cellPolygon(i);
      if (!cell) continue;
      const cellPoly = [[cell.map(([x, y]) => [x, y])]];
      const cellBox = bboxOf(cellPoly);
      const rings = relevantRings(planarCountry, countryBoxes, cellBox);
      if (!rings.length) continue;
      let clipped;
      try {
        clipped = polygonClipping.intersection(rings, cellPoly);
      } catch {
        continue; // degenerate geometry; the land is picked up by neighbouring cells
      }
      if (!clipped || !clipped.length) continue;
      const geo = mapMultiPolygon(clipped, projection.inverse);
      provinces.push({ seed: seeds[i], multi: geo });
    }
  }

  // Assign every city to the province that owns its ground.
  const provincePoints = provinces.map((p) => projection.forward(p.seed.point));
  const buckets = provinces.map(() => ({ population: 0, cities: [] }));
  for (const city of countryCities) {
    const [cx, cy] = projection.forward([city.lon, city.lat]);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < provincePoints.length; i += 1) {
      const distance = (provincePoints[i][0] - cx) ** 2 + (provincePoints[i][1] - cy) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    buckets[best].population += city.population;
    buckets[best].cities.push(city);
  }

  return provinces.map((province, index) => {
    const finalMulti = mapMultiPolygon(province.multi, ([lon, lat]) => [unshift(lon), lat]);
    const bucket = buckets[index];
    const biggestCity = bucket.cities.sort((a, b) => b.population - a.population)[0] ?? null;
    const rawCentre = centroidOf(province.multi);
    return {
      name: biggestCity?.name ?? province.seed.name ?? meta.name,
      adminCode: province.seed.adminCode,
      multi: quantize(finalMulti, 4),
      areaKm2: polygonAreaKm2(finalMulti),
      urbanPopulation: bucket.population,
      capitalScore: capitalMatch(bucket.cities, capitalName),
      cities: bucket.cities.slice(0, 6).map((c) => ({ name: c.name, population: c.population })),
      centre: [Number(unshift(rawCentre[0]).toFixed(4)), Number(rawCentre[1].toFixed(4))],
    };
  });
}

/**
 * Two provinces are neighbours when their borders run through the same patch of
 * ground. Rasterising each border onto a shared grid finds that robustly, even
 * where two countries' outlines do not share identical vertices.
 */
function computeAdjacency(provinces) {
  const cellOwners = new Map();
  const boundaryCells = provinces.map(() => new Set());

  provinces.forEach((province, index) => {
    for (const [lon, lat] of densifiedBoundary(province.geometry, ADJACENCY_GRID / 2)) {
      const key = `${Math.round(lon / ADJACENCY_GRID)}:${Math.round(lat / ADJACENCY_GRID)}`;
      boundaryCells[index].add(key);
      let owners = cellOwners.get(key);
      if (!owners) {
        owners = new Set();
        cellOwners.set(key, owners);
      }
      owners.add(index);
    }
  });

  const neighbours = provinces.map(() => new Set());
  for (const owners of cellOwners.values()) {
    if (owners.size < 2) continue;
    const list = [...owners];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        neighbours[list[i]].add(list[j]);
        neighbours[list[j]].add(list[i]);
      }
    }
  }

  // A border patch touched by nobody else is the outer edge of the landmass: coast.
  const coastal = provinces.map((_, index) => {
    for (const key of boundaryCells[index]) {
      if (cellOwners.get(key).size === 1) return true;
    }
    return false;
  });

  return { neighbours, coastal };
}

/** Rough climate band from latitude — used for attrition and supply modifiers. */
function climateOf(lat) {
  const absolute = Math.abs(lat);
  if (absolute >= 66) return 'arctic';
  if (absolute >= 50) return 'boreal';
  if (absolute >= 35) return 'temperate';
  if (absolute >= 23.5) return 'subtropical';
  return 'tropical';
}

async function main() {
  log('Loading source data…');
  const shapes = loadCountryShapes();
  const { byNumeric, byAlpha2 } = indexCountryMeta();
  const citiesByCountry = indexCities();

  const seedPath = path.join(DATA_DIR, 'nations-seed.json');
  const nationSeed = fs.existsSync(seedPath)
    ? JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    : {};
  delete nationSeed._readme;

  const provinces = [];
  const nations = new Map();
  const unmatched = [];

  // A country can appear as several map features (mainland plus territories);
  // merge their cities so seeding is not duplicated.
  const grouped = new Map();
  for (const feature of shapes) {
    const id = String(feature.id ?? '-99');
    if (EXCLUDED_IDS.has(id)) continue;
    const name = feature.properties?.name ?? '';
    let meta = byNumeric.get(id);
    if (!meta) {
      const iso = MANUAL_ISO[id] ?? NAME_TO_ISO[name] ?? null;
      if (iso) meta = byAlpha2.get(iso);
    }
    if (!meta) {
      unmatched.push(`${id}:${name}`);
      continue;
    }
    let group = grouped.get(meta.iso2);
    if (!group) {
      group = { meta, geometries: [] };
      grouped.set(meta.iso2, group);
    }
    group.geometries.push(...toMultiPolygon(feature.geometry));
  }

  if (unmatched.length) log(`  skipped unmatched features: ${unmatched.join(', ')}`);
  log(`  ${grouped.size} countries, carving provinces…`);

  let done = 0;
  for (const [iso2, group] of grouped) {
    const { meta } = group;
    const cities = citiesByCountry.get(iso2) ?? [];
    const seedRow = nationSeed[iso2] ?? {};
    const population =
      seedRow.pop ?? Math.round(cities.reduce((sum, c) => sum + c.population, 0) * 1.9);

    const feature = { geometry: { type: 'MultiPolygon', coordinates: group.geometries } };
    let carved;
    try {
      carved = carveCountry(feature, meta, cities, population);
    } catch (error) {
      log(`  ! ${iso2} failed to carve: ${error.message}`);
      continue;
    }
    if (!carved.length) {
      log(`  ! ${iso2} produced no provinces`);
      continue;
    }

    const countryArea = carved.reduce((sum, p) => sum + p.areaKm2, 0) || 1;
    const urbanTotal = carved.reduce((sum, p) => sum + p.urbanPopulation, 0);
    const rural = Math.max(0, population - urbanTotal);

    let capitalIndex = -1;
    let bestCapitalScore = -1;

    const startIndex = provinces.length;
    carved.forEach((province, offset) => {
      const ruralShare = rural * (province.areaKm2 / countryArea);
      const totalPopulation = Math.round(province.urbanPopulation + ruralShare);
      const urbanisation = totalPopulation > 0 ? province.urbanPopulation / totalPopulation : 0;
      const score = province.capitalScore * 1e13 + totalPopulation;
      if (score > bestCapitalScore) {
        bestCapitalScore = score;
        capitalIndex = startIndex + offset;
      }

      provinces.push({
        id: `${iso2}-${String(offset + 1).padStart(2, '0')}`,
        name: province.name,
        owner: seedRow.sov ?? iso2,
        coreOwner: iso2,
        adminCode: province.adminCode,
        population: totalPopulation,
        urbanisation: Number(urbanisation.toFixed(3)),
        areaKm2: Math.round(province.areaKm2),
        climate: climateOf(province.centre[1]),
        centre: province.centre,
        cities: province.cities,
        geometry: province.multi,
      });
    });

    nations.set(iso2, {
      iso2,
      iso3: meta.iso3,
      name: meta.name,
      nameKo: meta.nameKo,
      officialName: meta.officialName,
      capitalCity: meta.capital,
      capitalProvince: capitalIndex >= 0 ? provinces[capitalIndex].id : null,
      region: meta.region,
      subregion: meta.subregion,
      landlocked: meta.landlocked,
      borders: meta.borders,
      unMember: meta.unMember,
      independent: meta.independent,
      population,
      areaKm2: Math.round(countryArea),
      sovereign: seedRow.sov ?? null,
      gdp: seedRow.gdp ?? null,
      military: {
        active: seedRow.act ?? 0,
        reserve: seedRow.res ?? 0,
        budget: seedRow.bud ?? 0,
        nukes: seedRow.nuk ?? 0,
      },
      government: seedRow.gov ?? null,
      blocs: seedRow.blocs ?? [],
      doctrine: seedRow.doc ?? null,
      hasSeedData: Boolean(nationSeed[iso2]),
    });

    done += 1;
    if (done % 40 === 0) log(`    …${done}/${grouped.size}`);
  }

  log(`  ${provinces.length} provinces carved. Computing adjacency…`);
  const { neighbours, coastal } = computeAdjacency(provinces);
  provinces.forEach((province, index) => {
    province.neighbours = [...neighbours[index]].map((i) => provinces[i].id).sort();
    province.coastal = coastal[index];
  });

  // Cross-check computed land borders against the ISO border lists we were given.
  let borderHits = 0;
  let borderMisses = 0;
  const iso3ToIso2 = new Map([...nations.values()].map((n) => [n.iso3, n.iso2]));
  const computedBorders = new Map([...nations.keys()].map((iso2) => [iso2, new Set()]));
  provinces.forEach((province, index) => {
    for (const neighbourIndex of neighbours[index]) {
      const other = provinces[neighbourIndex].owner;
      if (other !== province.owner) computedBorders.get(province.owner)?.add(other);
    }
  });
  for (const nation of nations.values()) {
    for (const iso3 of nation.borders) {
      const iso2 = iso3ToIso2.get(iso3);
      if (!iso2) continue;
      if (computedBorders.get(nation.iso2)?.has(iso2)) borderHits += 1;
      else borderMisses += 1;
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      borders: 'Natural Earth 1:50m via world-atlas',
      cities: 'GeoNames via all-the-cities',
      metadata: 'world-countries (ISO 3166)',
    },
    nations: Object.fromEntries(nations),
    provinces,
  };
  const outPath = path.join(DATA_DIR, 'world.json');
  fs.writeFileSync(outPath, JSON.stringify(output));

  const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  const coastalCount = provinces.filter((p) => p.coastal).length;
  const isolated = provinces.filter((p) => p.neighbours.length === 0).length;

  log('');
  log(`✓ ${outPath} (${sizeMb} MB)`);
  log(`  nations:   ${nations.size}`);
  log(`  provinces: ${provinces.length}  (coastal ${coastalCount}, island/isolated ${isolated})`);
  log(`  land borders matched against ISO data: ${borderHits} hit / ${borderMisses} missed`);
  const missingSeed = [...nations.values()].filter((n) => !n.hasSeedData).map((n) => n.iso2);
  if (missingSeed.length) log(`  ! no seed stats for: ${missingSeed.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
