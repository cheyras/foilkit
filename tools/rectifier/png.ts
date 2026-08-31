// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Minimal pure-JS PNG codec over `node:zlib`.
//
// PROVENANCE. Ported from DeckPal's `apps/api/src/foil/png.ts` (branch
// `foil/main`), same sole author, so the port is clean under AGENTS.md F2. The
// reason it exists is unchanged: this toolchain pulls in no native image addon
// (no sharp, no node-canvas), the rasters are small, and a zlib-backed codec is
// the cheapest honest option. `RgbaImage` now comes from `homography.ts` so the
// rectifier has exactly one image shape.
//
// EXTENDED ON THE WAY OVER: palette (colour type 3, bit depths 1/2/4/8) and
// Adam7 interlacing. DeckPal's codec supported neither, because everything it
// ever read was a `canvas.toDataURL` PNG. The first two real catalog scans this
// rectifier was pointed at — TCGdex's `high.png` — are 8-bit PALETTISED and
// INTERLACED, so the original would have thrown on every one of them. That is
// the smoke test earning its place: the synthetic suite would never have found
// it. Recorded in DECISIONS.md.
//
// Scope:
//   decode: colour types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha),
//           6 (RGBA); bit depth 8, plus 1/2/4 for palette; interlaced or not.
//   encode: 8-bit RGBA, filter 0, one IDAT, non-interlaced.
// 16-bit throws — a caller treats that as a bad input, not a case to support.

import { deflateSync, inflateSync } from 'node:zlib';

import type { RgbaImage } from './homography.ts';

export type { RgbaImage };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── CRC32 (standard PNG polynomial) ────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Decode ─────────────────────────────────────────────────────────────────

/** Samples per pixel, by colour type. Palette (3) is one index per pixel. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Adam7: starting row, starting column, row step, column step, per pass. */
const ADAM7 = [
  { y0: 0, x0: 0, dy: 8, dx: 8 },
  { y0: 0, x0: 4, dy: 8, dx: 8 },
  { y0: 4, x0: 0, dy: 8, dx: 4 },
  { y0: 0, x0: 2, dy: 4, dx: 4 },
  { y0: 2, x0: 0, dy: 4, dx: 2 },
  { y0: 0, x0: 1, dy: 2, dx: 2 },
  { y0: 1, x0: 0, dy: 2, dx: 1 },
] as const;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/**
 * Undo the per-scanline filter for one pass and return the raw sample bytes.
 *
 * `bpp` — the filter's "bytes per pixel" — is 1 for sub-byte depths by
 * specification, not by approximation: at depth 4 the filter's left neighbour
 * is the previous BYTE, which holds two pixels.
 */
function unfilterPass(
  raw: Buffer,
  offset: number,
  passWidth: number,
  passHeight: number,
  channels: number,
  bitDepth: number,
): { bytes: Uint8Array; stride: number; consumed: number } {
  const stride = Math.ceil((passWidth * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const bytes = new Uint8Array(stride * passHeight);
  if (passWidth === 0 || passHeight === 0) return { bytes, stride, consumed: 0 };
  if (raw.length < offset + (stride + 1) * passHeight) throw new Error('PNG data short');

  for (let y = 0; y < passHeight; y++) {
    const rowOff = offset + y * (stride + 1);
    const filter = raw[rowOff]!;
    const out = y * stride;
    const up = out - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowOff + 1 + x]!;
      const left = x >= bpp ? bytes[out + x - bpp]! : 0;
      const above = y > 0 ? bytes[up + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? bytes[up + x - bpp]! : 0;
      let d: number;
      switch (filter) {
        case 0: d = v; break;
        case 1: d = v + left; break;
        case 2: d = v + above; break;
        case 3: d = v + ((left + above) >> 1); break;
        case 4: d = v + paeth(left, above, upLeft); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      bytes[out + x] = d & 0xff;
    }
  }
  return { bytes, stride, consumed: (stride + 1) * passHeight };
}

/** Read sample `n` of a scanline at the header's bit depth. */
function sampleAt(line: Uint8Array, lineOff: number, n: number, bitDepth: number): number {
  if (bitDepth === 8) return line[lineOff + n]!;
  const perByte = 8 / bitDepth;
  const byte = line[lineOff + Math.floor(n / perByte)]!;
  const shift = 8 - bitDepth * ((n % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function writePixel(
  rgba: Uint8Array,
  o: number,
  line: Uint8Array,
  lineOff: number,
  px: number,
  h: Header,
  palette: Uint8Array | null,
): void {
  const ch = CHANNELS[h.colorType]!;
  const s = (n: number) => sampleAt(line, lineOff, px * ch + n, h.bitDepth);
  switch (h.colorType) {
    case 0:
      rgba[o] = rgba[o + 1] = rgba[o + 2] = s(0);
      rgba[o + 3] = 255;
      break;
    case 2:
      rgba[o] = s(0); rgba[o + 1] = s(1); rgba[o + 2] = s(2); rgba[o + 3] = 255;
      break;
    case 3: {
      const idx = s(0) * 4;
      if (!palette || idx + 3 >= palette.length) throw new Error('palette index out of range');
      rgba[o] = palette[idx]!;
      rgba[o + 1] = palette[idx + 1]!;
      rgba[o + 2] = palette[idx + 2]!;
      rgba[o + 3] = palette[idx + 3]!;
      break;
    }
    case 4:
      rgba[o] = rgba[o + 1] = rgba[o + 2] = s(0);
      rgba[o + 3] = s(1);
      break;
    case 6:
      rgba[o] = s(0); rgba[o + 1] = s(1); rgba[o + 2] = s(2); rgba[o + 3] = s(3);
      break;
  }
}

export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let h: Header | null = null;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      h = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8]!,
        colorType: data[9]!,
        interlace: data[12]!,
      };
      if (!(h.colorType in CHANNELS)) throw new Error(`color type ${h.colorType} unsupported`);
      const depthOk = h.colorType === 3 ? [1, 2, 4, 8].includes(h.bitDepth) : h.bitDepth === 8;
      if (!depthOk) throw new Error(`bit depth ${h.bitDepth} unsupported for color type ${h.colorType}`);
      if (h.interlace !== 0 && h.interlace !== 1) throw new Error(`interlace method ${h.interlace} unsupported`);
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!h || !h.width || !h.height || idat.length === 0) throw new Error('truncated PNG');
  if (h.colorType === 3 && !plte) throw new Error('palette PNG with no PLTE chunk');

  // Flatten PLTE (+ tRNS alpha) into an RGBA lookup so the pixel loop is
  // branch-free on transparency.
  let palette: Uint8Array | null = null;
  if (plte) {
    const n = Math.floor(plte.length / 3);
    palette = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      palette[i * 4] = plte[i * 3]!;
      palette[i * 4 + 1] = plte[i * 3 + 1]!;
      palette[i * 4 + 2] = plte[i * 3 + 2]!;
      palette[i * 4 + 3] = trns && i < trns.length ? trns[i]! : 255;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const ch = CHANNELS[h.colorType]!;
  const rgba = new Uint8Array(h.width * h.height * 4);

  if (h.interlace === 0) {
    const { bytes, stride } = unfilterPass(raw, 0, h.width, h.height, ch, h.bitDepth);
    for (let y = 0; y < h.height; y++) {
      for (let x = 0; x < h.width; x++) {
        writePixel(rgba, (y * h.width + x) * 4, bytes, y * stride, x, h, palette);
      }
    }
    return { width: h.width, height: h.height, rgba };
  }

  let cursor = 0;
  for (const pass of ADAM7) {
    const passW = Math.ceil((h.width - pass.x0) / pass.dx);
    const passH = Math.ceil((h.height - pass.y0) / pass.dy);
    if (passW <= 0 || passH <= 0) continue;
    const { bytes, stride, consumed } = unfilterPass(raw, cursor, passW, passH, ch, h.bitDepth);
    cursor += consumed;
    for (let py = 0; py < passH; py++) {
      const y = pass.y0 + py * pass.dy;
      for (let px = 0; px < passW; px++) {
        const x = pass.x0 + px * pass.dx;
        writePixel(rgba, (y * h.width + x) * 4, bytes, py * stride, px, h, palette);
      }
    }
  }
  return { width: h.width, height: h.height, rgba };
}

// ── Encode ─────────────────────────────────────────────────────────────────

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(img: RgbaImage): Buffer {
  const { width, height, rgba } = img;
  if (rgba.length !== width * height * 4) throw new Error('rgba length mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // compression 0, filter 0, interlace 0 (already zeroed)

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 per row
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
