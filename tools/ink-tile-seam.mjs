// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/ink-tile-seam.mjs — does an ink tile meet ITSELF at the cell edge?
//
// An ink tile is ONE LATTICE CELL, repeated across the card by the shader. So
// the geometry it draws has to be the restriction of a pattern that already
// repeats: whatever leaves the right edge must arrive at the left edge, at the
// same height, and likewise top to bottom. A tile that does not do that draws a
// grid line — the seam — across every printing it is used on.
//
// That is not a thing a test suite notices and not a thing a code review
// notices. `pinstripe-diagonal.svg` shipped with the two corner triangles that
// carry the neighbouring stripes drawn at HALF the size the geometry needs
// (legs of 13 where the band's half-width is 26), and it read as a perfectly
// reasonable file: three paths, round numbers, a `desc` that said "tiles
// seamlessly". It measured a mean |Δcoverage| of 66/255 across its own wrap.
//
// So it is measured, for every tile, on every build.
//
// ── WHAT IS MEASURED ───────────────────────────────────────────────────────
//
// Coverage is sampled just inside each of the four cell edges and compared with
// the sample just inside the opposite edge at the same offset along it:
//
//   |f(0⁺, y) − f(100⁻, y)|   and   |f(x, 0⁺) − f(x, 100⁻)|
//
// averaged over the samples and scaled to 0..255, which is the unit the tile is
// eventually rasterised into. A seamless tile measures exactly 0, because the
// two limits agree everywhere except on the measure-zero set where the boundary
// itself crosses the seam — and the sample positions are half-offset so they
// never land there.
//
// ── WHY AN ANALYTIC SAMPLER AND NOT A RASTERISER ───────────────────────────
//
// This runs inside `tools/build-ink-index.mjs`, which is plain Node with no
// dependencies, in a repository that deliberately does not carry a browser or
// an image toolkit for its build steps. The tiles are a handful of rects,
// circles and short paths — the exact subset below — so an inside-test over the
// real geometry is both smaller than a rasteriser and EXACT, which a rasteriser
// with antialiasing would not be. An element outside the subset is a hard
// failure rather than a silent 0: a tile this file cannot read is a tile whose
// seam nobody has measured, and those are indistinguishable from the outside.

/** The viewBox every tile is authored in. Enforced by the parser. */
export const CELL = 100

// ── The tiny SVG subset ────────────────────────────────────────────────────

class UnsupportedTile extends Error {}

/** Numbers out of a path data string or an attribute list. */
function numbers(s) {
  const out = [];
  const re = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(Number(m[0]));
  return out;
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m === null ? null : m[1];
}

/**
 * SVG elliptical arc, endpoint parameterisation -> a polyline.
 *
 * The F.6.5 conversion, verbatim, because `ring-dot.svg` draws its annulus as
 * two semicircular arcs and approximating them as chords would report a seam
 * that is an artefact of the approximation. Flattened at 1/4 degree, which is
 * three orders of magnitude finer than the seam test's own resolution.
 */
function arcToPoints(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let ax = Math.abs(rx);
  let ay = Math.abs(ry);
  const lambda = (x1p * x1p) / (ax * ax) + (y1p * y1p) / (ay * ay);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    ax *= s;
    ay *= s;
  }
  const num = ax * ax * ay * ay - ax * ax * y1p * y1p - ay * ay * x1p * x1p;
  const den = ax * ax * y1p * y1p + ay * ay * x1p * x1p;
  const co = Math.sqrt(Math.max(0, num / den)) * (largeArc === sweep ? -1 : 1);
  const cxp = (co * ax * y1p) / ay;
  const cyp = (-co * ay * x1p) / ax;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / ax, (y1p - cyp) / ay);
  let dt = ang((x1p - cxp) / ax, (y1p - cyp) / ay, (-x1p - cxp) / ax, (-y1p - cyp) / ay);
  if (sweep === 0 && dt > 0) dt -= 2 * Math.PI;
  if (sweep === 1 && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(Math.abs(dt) / (Math.PI / 720)));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = t1 + (dt * i) / steps;
    const px = Math.cos(t) * ax;
    const py = Math.sin(t) * ay;
    pts.push([cosP * px - sinP * py + cx, sinP * px + cosP * py + cy]);
  }
  return pts;
}

/** One `d` attribute -> a list of closed rings of points. M/L/H/V/A/Z only. */
function pathRings(d) {
  const rings = [];
  let ring = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const tokens = d.match(/[MmLlHhVvAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = null;
  const close = () => {
    if (ring.length > 2) rings.push(ring);
    ring = [];
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[MmLlHhVvAaZz]/.test(t)) {
      cmd = t;
      i++;
    } else if (cmd === null) {
      throw new UnsupportedTile(`path data starts with a number: ${d}`);
    }
    const rel = cmd === cmd.toLowerCase();
    const take = (n) => {
      const out = tokens.slice(i, i + n).map(Number);
      if (out.length < n || out.some(Number.isNaN)) throw new UnsupportedTile(`bad path data near "${d.slice(0, 40)}"`);
      i += n;
      return out;
    };
    switch (cmd.toUpperCase()) {
      case 'M': {
        const [x, y] = take(2);
        close();
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        sx = cx;
        sy = cy;
        ring = [[cx, cy]];
        cmd = rel ? 'l' : 'L'; // an implicit repeat after M is a lineto
        break;
      }
      case 'L': {
        const [x, y] = take(2);
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        ring.push([cx, cy]);
        break;
      }
      case 'H': {
        const [x] = take(1);
        cx = rel ? cx + x : x;
        ring.push([cx, cy]);
        break;
      }
      case 'V': {
        const [y] = take(1);
        cy = rel ? cy + y : y;
        ring.push([cx, cy]);
        break;
      }
      case 'A': {
        const [rx, ry, rot, fa, fs, x, y] = take(7);
        const nx = rel ? cx + x : x;
        const ny = rel ? cy + y : y;
        for (const p of arcToPoints(cx, cy, rx, ry, rot, fa, fs, nx, ny)) ring.push(p);
        cx = nx;
        cy = ny;
        break;
      }
      case 'Z': {
        cx = sx;
        cy = sy;
        close();
        break;
      }
      default:
        throw new UnsupportedTile(`unsupported path command "${cmd}"`);
    }
  }
  close();
  return rings;
}

/** Crossing count / winding number of a ring about a point. */
function ringHits(ring, x, y) {
  let crossings = 0;
  let winding = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y) {
      const t = (y - yi) / (yj - yi);
      if (x < xi + t * (xj - xi)) {
        crossings++;
        winding += yj > yi ? 1 : -1;
      }
    }
  }
  return { crossings, winding };
}

/**
 * Parse a tile into shapes, each of which answers "is this point inked".
 *
 * Anything the subset does not cover throws. See the header: an unreadable tile
 * is an unmeasured tile, and an unmeasured tile is why this file exists.
 */
export function parseTile(svg, label = 'tile') {
  const viewBox = attr(svg, 'viewBox');
  if (viewBox !== `0 0 ${CELL} ${CELL}`)
    throw new UnsupportedTile(`${label}: viewBox must be "0 0 ${CELL} ${CELL}", got "${viewBox}"`);
  const shapes = [];
  const body = svg.replace(/<(title|desc)\b[\s\S]*?<\/\1>/g, '');
  for (const m of body.matchAll(/<(rect|circle|ellipse|path|polygon|polyline|line|g|use|image|text)\b([^>]*)>/g)) {
    const [, name, rest] = m;
    const tag = `<${name}${rest}>`;
    if (name === 'rect') {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((a) => Number(attr(tag, a) ?? 0));
      if (attr(tag, 'rx') !== null || attr(tag, 'ry') !== null)
        throw new UnsupportedTile(`${label}: a rounded rect is outside the subset this file can measure`);
      shapes.push((px, py) => px >= x && px <= x + w && py >= y && py <= y + h);
    } else if (name === 'circle') {
      const cx = Number(attr(tag, 'cx') ?? 0);
      const cy = Number(attr(tag, 'cy') ?? 0);
      const r = Number(attr(tag, 'r') ?? 0);
      shapes.push((px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r);
    } else if (name === 'polygon') {
      const n = numbers(attr(tag, 'points') ?? '');
      const ring = [];
      for (let i = 0; i + 1 < n.length; i += 2) ring.push([n[i], n[i + 1]]);
      shapes.push((px, py) => ringHits(ring, px, py).crossings % 2 === 1);
    } else if (name === 'path') {
      const rings = pathRings(attr(tag, 'd') ?? '');
      const evenOdd = (attr(tag, 'fill-rule') ?? 'nonzero') === 'evenodd';
      shapes.push((px, py) => {
        let crossings = 0;
        let winding = 0;
        for (const ring of rings) {
          const h = ringHits(ring, px, py);
          crossings += h.crossings;
          winding += h.winding;
        }
        return evenOdd ? crossings % 2 === 1 : winding !== 0;
      });
    } else {
      throw new UnsupportedTile(
        `${label}: <${name}> is outside the subset tools/ink-tile-seam.mjs can measure. Extend this file rather ` +
          'than shipping a tile whose seam nobody has checked.',
      );
    }
  }
  if (shapes.length === 0) throw new UnsupportedTile(`${label}: no drawable element at all`);
  return shapes;
}

/** Ink coverage at one point: 1 inside any shape, 0 otherwise. */
export function coverageAt(shapes, x, y) {
  for (const inside of shapes) if (inside(x, y)) return 1;
  return 0;
}

/**
 * Mean |Δcoverage| across the cell's own wrap, in 0..255. 0 = seamless.
 *
 * `EDGE` is the inset the two limits are taken at, and it is deliberately far
 * below any authored coordinate: the question is what the pattern does AT the
 * boundary, and a wider inset would measure the geometry a little way inside it
 * instead. The sample positions are half-offset so they never land on a
 * coordinate a tile is likely to be authored on (26, 50, 74 …), where the two
 * limits legitimately disagree on a set of measure zero.
 */
export function seamError(svg, { label = 'tile', samples = 512 } = {}) {
  const shapes = parseTile(svg, label);
  const EDGE = 1e-6;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const t = ((i + 0.5) * CELL) / samples;
    total += Math.abs(coverageAt(shapes, EDGE, t) - coverageAt(shapes, CELL - EDGE, t));
    total += Math.abs(coverageAt(shapes, t, EDGE) - coverageAt(shapes, t, CELL - EDGE));
  }
  // Rounded so the number is stable across platforms and diffable in the index.
  return Math.round(((total / (samples * 2)) * 255 + Number.EPSILON) * 1000) / 1000;
}
