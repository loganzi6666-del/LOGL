/**
 * Geometry helpers for the world builder.
 *
 * Everything here works on GeoJSON-style coordinate arrays in [lon, lat] order.
 * Countries are subdivided in a local equal-ish plane so that Voronoi cells look
 * natural instead of being stretched towards the poles.
 */

const DEG = Math.PI / 180;

/**
 * Countries that straddle the antimeridian (Russia, Fiji, the US with the
 * Aleutians) arrive with longitudes at both ends of the -180..180 range, which
 * would tear any planar computation in half. Detect that case and shift the
 * negative side into 180..360 so the country is contiguous again.
 */
export function needsUnwrap(rings) {
  let min = Infinity;
  let max = -Infinity;
  for (const ring of rings) {
    for (const [lon] of ring) {
      if (lon < min) min = lon;
      if (lon > max) max = lon;
    }
  }
  return max - min > 180;
}

export const unwrapLon = (lon) => (lon < 0 ? lon + 360 : lon);
export const rewrapLon = (lon) => (lon > 180 ? lon - 360 : lon);

/** Flatten a Polygon/MultiPolygon geometry into polygon-clipping's MultiPolygon form. */
export function toMultiPolygon(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** Bounding box [minX, minY, maxX, maxY] of a polygon-clipping MultiPolygon. */
export function bboxOf(multiPolygon) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of multiPolygon) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

export function bboxIntersects(a, b) {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/**
 * A local planar projection anchored on the country's own centre. Longitudes are
 * squeezed by cos(lat) so a degree of longitude covers roughly the same ground
 * as a degree of latitude, which keeps Voronoi cells from turning into slivers
 * at high latitude.
 */
export function makeLocalProjection(lat0) {
  const k = Math.max(0.15, Math.cos(lat0 * DEG));
  return {
    forward: ([lon, lat]) => [lon * k, lat],
    inverse: ([x, y]) => [x / k, y],
  };
}

export function mapMultiPolygon(multiPolygon, fn) {
  return multiPolygon.map((polygon) => polygon.map((ring) => ring.map(fn)));
}

/** Great-circle-ish area in km^2, good enough for gameplay weighting. */
export function polygonAreaKm2(multiPolygon) {
  const R = 6371.0088;
  let total = 0;
  for (const polygon of multiPolygon) {
    polygon.forEach((ring, index) => {
      const area = Math.abs(ringAreaSteradians(ring)) * R * R;
      total += index === 0 ? area : -area;
    });
  }
  return Math.abs(total);
}

function ringAreaSteradians(ring) {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    total += (lon2 - lon1) * DEG * (2 + Math.sin(lat1 * DEG) + Math.sin(lat2 * DEG));
  }
  return total / 2;
}

/** Area-weighted centroid of a MultiPolygon, in [lon, lat]. */
export function centroidOf(multiPolygon) {
  let sumX = 0;
  let sumY = 0;
  let sumArea = 0;
  for (const polygon of multiPolygon) {
    const ring = polygon[0];
    if (!ring || ring.length < 3) continue;
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    area /= 2;
    if (Math.abs(area) < 1e-12) continue;
    cx /= 6 * area;
    cy /= 6 * area;
    const weight = Math.abs(area);
    sumX += cx * weight;
    sumY += cy * weight;
    sumArea += weight;
  }
  if (sumArea === 0) {
    const ring = multiPolygon[0]?.[0] ?? [[0, 0]];
    return [ring[0][0], ring[0][1]];
  }
  return [sumX / sumArea, sumY / sumArea];
}

/** Ray-casting point-in-polygon against a MultiPolygon, holes included. */
export function pointInMultiPolygon(point, multiPolygon) {
  for (const polygon of multiPolygon) {
    if (!pointInRing(point, polygon[0])) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i += 1) {
      if (pointInRing(point, polygon[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function pointInRing([x, y], ring) {
  if (!ring) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Round every coordinate to `digits` decimals and drop points that collapse together. */
export function quantize(multiPolygon, digits = 4) {
  const factor = 10 ** digits;
  const round = (v) => Math.round(v * factor) / factor;
  const result = [];
  for (const polygon of multiPolygon) {
    const rings = [];
    for (const ring of polygon) {
      const out = [];
      let prev = null;
      for (const [x, y] of ring) {
        const point = [round(x), round(y)];
        if (prev && prev[0] === point[0] && prev[1] === point[1]) continue;
        out.push(point);
        prev = point;
      }
      if (out.length >= 3) {
        const first = out[0];
        const last = out[out.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
        if (out.length >= 4) rings.push(out);
      }
    }
    if (rings.length) result.push(rings);
  }
  return result;
}

/**
 * Walk every boundary segment, emitting points no further apart than `step`.
 * Used to rasterise borders onto a grid for adjacency detection, where a gap
 * would mean a missed neighbour.
 */
export function* densifiedBoundary(multiPolygon, step) {
  for (const polygon of multiPolygon) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const distance = Math.hypot(dx, dy);
        const steps = Math.max(1, Math.ceil(distance / step));
        for (let s = 0; s < steps; s += 1) {
          const t = s / steps;
          yield [x0 + dx * t, y0 + dy * t];
        }
      }
    }
  }
}
