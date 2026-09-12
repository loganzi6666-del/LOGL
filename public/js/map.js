/**
 * The world map.
 *
 * Provinces are projected once into cached `Path2D` objects and redrawn under a
 * zoom transform, so panning stays smooth with sixteen hundred polygons on
 * screen. d3-geo does the projection and antimeridian cutting; the canvas does
 * the rest.
 *
 * Ownership is shown by fill colour. Occupation — territory held but not owned —
 * is shown by a diagonal hatch over the owner's colour, so a front line reads
 * correctly without relying on colour alone.
 */

import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom';

import { HUES, PLAYER_COLOUR, STATUS, colourNations, shade, withAlpha } from './palette.js';

const MIN_ZOOM = 0.9;
const MAX_ZOOM = 60;

export class WorldMap {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect ?? (() => {});
    this.onHover = onHover ?? (() => {});

    this.provinces = [];
    this.byId = new Map();
    this.colours = new Map();
    this.state = null;
    this.transform = zoomIdentity;
    this.hovered = null;
    this.selected = null;
    this.theme = 'light';
    this.showArmies = true;
    this.flash = new Map();
    this.frame = null;

    this.projection = geoNaturalEarth1();
    this.path = geoPath(this.projection);

    this.zoom = d3zoom()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .on('zoom', (event) => {
        this.transform = event.transform;
        this.render();
      });

    select(canvas)
      .call(this.zoom)
      .on('mousemove', (event) => this.handleMove(event))
      .on('mouseleave', () => {
        if (this.hovered) {
          this.hovered = null;
          this.onHover(null);
          this.render();
        }
      })
      .on('click', (event) => {
        const hit = this.pick(event);
        this.selected = hit?.id ?? null;
        this.onSelect(hit?.id ?? null);
        this.render();
      });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
  }

  /** One-time setup from the static geometry payload. */
  load({ provinces, adjacency, nations }) {
    this.rawProvinces = provinces;
    this.colourIndex = colourNations(adjacency, Object.keys(nations ?? {}));
    this.resize();
  }

  setTheme(theme) {
    this.theme = theme;
    this.hatch = null;
    this.render();
  }

  setState(state) {
    this.state = state;
    this.render();
  }

  /** Briefly outline provinces that changed hands, so the eye finds them. */
  highlightChanges(changes) {
    const until = performance.now() + 6000;
    for (const change of changes) this.flash.set(change.province, { until, annexed: change.annexed });
    this.render();
    if (!this.flashTimer) {
      this.flashTimer = setInterval(() => {
        const now = performance.now();
        let live = false;
        for (const [id, entry] of this.flash) {
          if (entry.until < now) this.flash.delete(id);
          else live = true;
        }
        this.render();
        if (!live) {
          clearInterval(this.flashTimer);
          this.flashTimer = null;
        }
      }, 250);
    }
  }

  resize() {
    const parent = this.canvas.parentElement ?? this.canvas;
    const width = parent.clientWidth || 960;
    const height = parent.clientHeight || 600;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // Fit the whole world, then re-project every province into cached paths.
    this.projection.fitExtent(
      [
        [8, 8],
        [width - 8, height - 8],
      ],
      { type: 'Sphere' },
    );
    this.rebuildPaths();
    this.render();
  }

  rebuildPaths() {
    if (!this.rawProvinces) return;
    this.provinces = [];
    this.byId.clear();

    for (const province of this.rawProvinces) {
      const feature = {
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: province.geometry },
      };
      const d = this.path(feature);
      if (!d) continue;
      const entry = {
        ...province,
        path: new Path2D(d),
        bounds: this.path.bounds(feature),
        point: this.projection(province.centre),
      };
      this.provinces.push(entry);
      this.byId.set(province.id, entry);
    }

    // Draw the biggest first so small states end up on top and stay clickable.
    this.provinces.sort((a, b) => b.area - a.area);
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  pointerPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  /** Which province is under the pointer, if any. */
  pick(event) {
    const [px, py] = this.pointerPosition(event);
    const [x, y] = this.transform.invert([px, py]);

    // Bounding boxes are in projected space, so this filter is a cheap first cut.
    for (let i = this.provinces.length - 1; i >= 0; i -= 1) {
      const province = this.provinces[i];
      const [[x0, y0], [x1, y1]] = province.bounds;
      if (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1) continue;
      this.ctx.save();
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const hit = this.ctx.isPointInPath(province.path, x, y);
      this.ctx.restore();
      if (hit) return province;
    }
    return null;
  }

  handleMove(event) {
    const hit = this.pick(event);
    const id = hit?.id ?? null;
    if (id === this.hovered) return;
    this.hovered = id;
    this.onHover(hit ? { province: hit, position: this.pointerPosition(event) } : null);
    this.render();
  }

  zoomTo(provinceId, scale = 8) {
    const province = this.byId.get(provinceId);
    if (!province) return;
    const [x, y] = province.point;
    const next = zoomIdentity
      .translate(this.width / 2, this.height / 2)
      .scale(scale)
      .translate(-x, -y);
    select(this.canvas).transition().duration(600).call(this.zoom.transform, next);
  }

  resetZoom() {
    select(this.canvas).transition().duration(500).call(this.zoom.transform, zoomIdentity);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  colourFor(iso2) {
    if (!iso2) return this.theme === 'dark' ? '#2c2c2a' : '#e1e0d9';
    if (this.state?.meta?.playerNation === iso2) return PLAYER_COLOUR[this.theme];
    const index = this.colourIndex?.get(iso2);
    if (index === undefined) return this.theme === 'dark' ? '#4a4a46' : '#c3c2b7';
    return HUES[index][this.theme];
  }

  /** The diagonal fill that marks occupied ground. */
  hatchFor(colour) {
    const key = `${colour}|${this.theme}`;
    if (this.hatchCache?.key === key) return this.hatchCache.pattern;
    const tile = document.createElement('canvas');
    const size = 8;
    tile.width = size;
    tile.height = size;
    const tc = tile.getContext('2d');
    tc.strokeStyle = colour;
    tc.lineWidth = 2.5;
    tc.beginPath();
    tc.moveTo(-size, size);
    tc.lineTo(size, -size);
    tc.moveTo(0, size * 2);
    tc.lineTo(size * 2, 0);
    tc.stroke();
    const pattern = this.ctx.createPattern(tile, 'repeat');
    this.hatchCache = { key, pattern };
    return pattern;
  }

  render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  draw() {
    const { ctx, dpr, transform } = this;
    if (!ctx || !this.width) return;

    const dark = this.theme === 'dark';
    const sea = dark ? '#0a0d12' : '#e8edf2';
    const ink = dark ? '#ffffff' : '#0b0b0b';
    const hairline = dark ? 'rgba(255,255,255,0.18)' : 'rgba(11,11,11,0.16)';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.setTransform(dpr * transform.k, 0, 0, dpr * transform.k, dpr * transform.x, dpr * transform.y);

    const k = transform.k;
    const px = 1 / k; // one screen pixel, in projected units
    const runtime = this.state?.provinces ?? {};
    const player = this.state?.meta?.playerNation;

    // Visible area in projected space, for culling.
    const [vx0, vy0] = transform.invert([0, 0]);
    const [vx1, vy1] = transform.invert([this.width, this.height]);
    const visible = (province) => {
      const [[x0, y0], [x1, y1]] = province.bounds;
      return !(x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1);
    };

    const drawn = [];

    // 1. Territory.
    for (const province of this.provinces) {
      if (!visible(province)) continue;
      drawn.push(province);
      const live = runtime[province.id];
      const owner = live?.o ?? province.core;
      const controller = live?.c ?? owner;

      const base = this.colourFor(owner);
      // Devastated land is visibly drained of colour.
      const devastation = (live?.d ?? 0) / 100;
      ctx.fillStyle = devastation > 0.05 ? shade(base, dark ? -devastation * 0.5 : devastation * 0.55) : base;
      ctx.fill(province.path);

      if (controller !== owner) {
        // Held, not owned: the occupier's colour hatched over the owner's.
        ctx.save();
        ctx.clip(province.path);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = this.hatchFor(this.colourFor(controller));
        const [[x0, y0], [x1, y1]] = province.bounds;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
      }
    }

    // 2. Province borders, then national borders on top.
    ctx.lineJoin = 'round';
    if (k > 1.6) {
      ctx.strokeStyle = hairline;
      ctx.lineWidth = 0.4 * px;
      for (const province of drawn) ctx.stroke(province.path);
    }

    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.55)' : 'rgba(11,11,11,0.55)';
    ctx.lineWidth = Math.max(0.5, 1.1) * px;
    for (const province of drawn) {
      const owner = runtime[province.id]?.o ?? province.core;
      // Only stroke where the neighbour belongs to someone else.
      const external = (province.neighbours ?? []).length === 0;
      if (external || this.isBorderProvince(province, owner, runtime)) ctx.stroke(province.path);
    }

    // 3. The player's own frontier, emphasised.
    if (player) {
      ctx.strokeStyle = dark ? '#ffffff' : '#0b0b0b';
      ctx.lineWidth = 2.2 * px;
      for (const province of drawn) {
        if ((runtime[province.id]?.o ?? province.core) !== player) continue;
        ctx.stroke(province.path);
      }
    }

    // 4. Active fronts.
    for (const province of drawn) {
      const progress = runtime[province.id]?.p ?? 0;
      if (progress <= 0) continue;
      ctx.strokeStyle = STATUS.critical;
      ctx.lineWidth = (1.5 + (progress / 100) * 3) * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.stroke(province.path);
      ctx.setLineDash([]);
    }

    // 5. Provinces that just changed hands.
    const now = performance.now();
    for (const [id, entry] of this.flash) {
      const province = this.byId.get(id);
      if (!province || !visible(province)) continue;
      const remaining = Math.max(0, entry.until - now) / 6000;
      ctx.strokeStyle = entry.annexed ? STATUS.warning : STATUS.serious;
      ctx.lineWidth = (2 + 5 * remaining) * px;
      ctx.globalAlpha = 0.4 + 0.6 * remaining;
      ctx.stroke(province.path);
      ctx.globalAlpha = 1;
    }

    // 6. Selection and hover.
    for (const [id, width] of [
      [this.selected, 2.6],
      [this.hovered, 1.8],
    ]) {
      const province = id && this.byId.get(id);
      if (!province) continue;
      ctx.strokeStyle = id === this.selected ? STATUS.warning : ink;
      ctx.lineWidth = width * px;
      ctx.stroke(province.path);
    }

    ctx.restore();

    // 7. Armies, drawn in screen space so they stay legible at any zoom.
    if (this.showArmies && this.state?.armies) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Showing every nation's forces buries the map in markers, and a player
      // should not have perfect sight of armies they have nothing to do with.
      const playerNation = this.state.nations?.[player];
      const visibleOwners = new Set([
        player,
        ...(playerNation?.allies ?? []),
        ...(playerNation?.atWarWith ?? []),
      ]);

      const grouped = new Map();
      for (const army of this.state.armies) {
        const nearSelection =
          this.selected &&
          (army.province === this.selected ||
            (this.byId.get(this.selected)?.neighbours ?? []).includes(army.province));
        if (!visibleOwners.has(army.owner) && !nearSelection) continue;
        const key = `${army.province}|${army.owner}`;
        const existing = grouped.get(key);
        if (existing) existing.strength += army.strength;
        else grouped.set(key, { ...army });
      }

      for (const army of grouped.values()) {
        const province = this.byId.get(army.province);
        if (!province) continue;
        const [sx, sy] = transform.apply(province.point);
        if (sx < -20 || sy < -20 || sx > this.width + 20 || sy > this.height + 20) continue;

        const radius = Math.min(16, 3.2 + Math.sqrt(army.strength) * 1.5);
        if (radius < 3.5 && k < 2) continue; // hide clutter when zoomed out

        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(this.colourFor(army.owner) === PLAYER_COLOUR[this.theme]
          ? (dark ? '#ffffff' : '#0b0b0b')
          : this.colourFor(army.owner), 0.92);
        ctx.fill();
        // A 2px ring in the surface colour keeps overlapping markers separable.
        ctx.strokeStyle = sea;
        ctx.lineWidth = 2;
        ctx.stroke();

        if (radius >= 9) {
          ctx.fillStyle = dark ? '#0b0b0b' : '#ffffff';
          if (army.owner === player) ctx.fillStyle = dark ? '#0b0b0b' : '#ffffff';
          ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(Math.round(army.strength)), sx, sy);
        }
      }
    }

    // 8. Province labels, once the view is close enough to read them.
    if (k > 5) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const province of drawn) {
        const [sx, sy] = transform.apply(province.point);
        if (sx < 40 || sy < 16 || sx > this.width - 40 || sy > this.height - 16) continue;
        if (placed.some(([x, y]) => Math.abs(x - sx) < 64 && Math.abs(y - sy) < 18)) continue;
        placed.push([sx, sy]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = dark ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
        ctx.strokeText(province.name, sx, sy - 16);
        ctx.fillStyle = ink;
        ctx.fillText(province.name, sx, sy - 16);
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Does this province sit on a national border? */
  isBorderProvince(province, owner, runtime) {
    for (const neighbour of province.neighbours ?? []) {
      const other = runtime[neighbour]?.o;
      if (other && other !== owner) return true;
    }
    return false;
  }
}
