/**
 * Map colouring.
 *
 * A political map has two hundred categories, so hues cannot simply be handed
 * out one per nation. Cartography solves this by colouring the adjacency graph:
 * no two nations that share a border may share a colour. Here that is done with
 * a measured separation matrix, so neighbours are not merely different but
 * *distinguishable* — including to colourblind readers, which is the pairing a
 * naive hash-to-hue gets wrong most often.
 */

/** The validated eight-hue categorical palette, stepped for each surface. */
export const HUES = [
  { name: 'blue', light: '#2a78d6', dark: '#3987e5' },
  { name: 'orange', light: '#eb6834', dark: '#d95926' },
  { name: 'aqua', light: '#1baf7a', dark: '#199e70' },
  { name: 'yellow', light: '#eda100', dark: '#c98500' },
  { name: 'magenta', light: '#e87ba4', dark: '#d55181' },
  { name: 'green', light: '#008300', dark: '#008300' },
  { name: 'violet', light: '#4a3aa7', dark: '#9085e9' },
  { name: 'red', light: '#e34948', dark: '#e66767' },
];

/**
 * Worst-case perceptual distance between each pair of hues, taken as the minimum
 * across normal vision and the three colour-vision deficiencies, in both light
 * and dark mode (OKLab ×100; measured with the palette validator).
 *
 * Some pairs are genuinely hard to tell apart — blue/violet at 1.9, aqua/magenta
 * at 1.6 — so the colouring below actively avoids putting them across a border
 * from each other.
 */
const SEPARATION = [
  [99, 24.7, 19.6, 27.4, 13.0, 26.5, 1.9, 19.2],
  [24.7, 99, 9.2, 4.8, 10.5, 2.7, 26.0, 5.6],
  [19.6, 9.2, 99, 8.4, 1.6, 11.5, 17.3, 6.5],
  [27.4, 4.8, 8.4, 99, 13.2, 6.9, 27.3, 6.7],
  [13.0, 10.5, 1.6, 13.2, 99, 13.0, 16.0, 7.5],
  [26.5, 2.7, 11.5, 6.9, 13.0, 99, 26.9, 7.2],
  [1.9, 26.0, 17.3, 27.3, 16.0, 26.9, 99, 19.5],
  [19.2, 5.6, 6.5, 6.7, 7.5, 7.2, 19.5, 99],
];

/** The player's own territory is never one of the eight — it must read as "us". */
export const PLAYER_COLOUR = { light: '#0b0b0b', dark: '#ffffff' };

/** Reserved status colours. Always paired with an icon or label, never alone. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

/**
 * Assign a hue index to every nation so that bordering nations differ, choosing
 * — among the colours that are free — the one that stands furthest from the
 * neighbours already coloured.
 *
 * @param {Record<string, string[]>} adjacency nation code → bordering nation codes
 * @returns {Map<string, number>} nation code → index into HUES
 */
export function colourNations(adjacency, allNations = []) {
  // Island nations have no land neighbours and so never appear in the adjacency
  // map. They still need a colour, so seed the roster from both sources.
  const roster = new Set([...Object.keys(adjacency), ...allNations]);
  for (const list of Object.values(adjacency)) for (const other of list) roster.add(other);

  // Colour the most constrained nations first — the ones with the most
  // neighbours — which is what makes a single greedy pass succeed on a real map.
  const ordered = [...roster].sort(
    (a, b) => (adjacency[b]?.length ?? 0) - (adjacency[a]?.length ?? 0) || a.localeCompare(b),
  );

  const assigned = new Map();
  const usage = new Array(HUES.length).fill(0);

  for (const iso2 of ordered) {
    const taken = new Set(
      (adjacency[iso2] ?? []).map((other) => assigned.get(other)).filter((i) => i !== undefined),
    );

    let best = 0;
    let bestScore = -Infinity;
    let bestUsage = Infinity;

    for (let candidate = 0; candidate < HUES.length; candidate += 1) {
      // A colour already used across one of our borders is disqualified; among
      // the rest, prefer the one that is hardest to confuse with a neighbour.
      let score;
      if (taken.has(candidate)) {
        score = -1000;
      } else if (taken.size === 0) {
        score = 0; // unconstrained — the usage tie-break decides
      } else {
        score = Math.min(...[...taken].map((index) => SEPARATION[candidate][index]));
      }

      // Spreading the palette evenly is what stops half the world going blue.
      if (score > bestScore || (score === bestScore && usage[candidate] < bestUsage)) {
        bestScore = score;
        bestUsage = usage[candidate];
        best = candidate;
      }
    }

    assigned.set(iso2, best);
    usage[best] += 1;
  }
  return assigned;
}

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Mix towards white or black, for shading a nation's provinces apart. */
export function shade(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return `rgb(${Math.round(r + (target - r) * t)}, ${Math.round(g + (target - g) * t)}, ${Math.round(
    b + (target - b) * t,
  )})`;
}

export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
