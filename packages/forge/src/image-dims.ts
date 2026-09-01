// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// foil/image-dims.ts — raster dimensions from a file HEADER, no decoder.
//
// WHY THIS IS SEPARATE FROM png.ts. png.ts is a codec: it inflates IDAT and
// un-filters scanlines, which for a 504 x 704 RGBA mask is ~1.4 MB of work.
// The frame registry only ever needs the two integers in the header, and it
// needs them for WebP too (the image store is `.webp` throughout) — a format
// png.ts has no business knowing about. So: one tiny function that reads the
// first few dozen bytes and answers the only question the registry asks.
//
// THE POINT OF IT, in one line: a sidecar's `width`/`height` are JSON a caller
// wrote, and the frame a mask lives in must be decided by the PIXELS. Same rule
// as `derivation_method` and `frame` itself — derived, never claimed. A sidecar
// hand-edited (or written by a buggy client) to say 504 x 704 beside a
// 490 x 674 PNG resolves from the PNG.
//
// Scope is deliberately PNG + WebP: PNG is what the mask pipeline writes, WebP
// is what the object store holds. Anything else returns null and the caller
// falls back to the JSON, which is the honest degradation — a wrong guess from
// a format we cannot read would be worse than the claim we already had.

export interface HeaderDims {
  format: 'png' | 'webp';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Bytes that always suffice. PNG needs 24 (signature 8 + length 4 + 'IHDR' 4 +
 * w 4 + h 4; IHDR is required by the spec to be the first chunk). WebP's
 * longest case is the VP8X extended header at 30. Read this many and no more.
 */
export const HEADER_BYTES = 32;

const ascii = (b: Buffer, from: number, to: number): string => (b.length >= to ? b.toString('ascii', from, to) : '');

/**
 * Dimensions from an image header, or null when the bytes are not a format
 * this understands (or are truncated). Never throws: a caller reading a file
 * that might not be there wants an answer, not a control-flow exception.
 */
export function headerDims(buf: Buffer): HeaderDims | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (ascii(buf, 12, 16) !== 'IHDR') return null;
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 16 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') {
    const chunk = ascii(buf, 12, 16);
    // Lossy: 'VP8 ' + size(4) + 3-byte start code + 0x9d012a + w/h as 14-bit
    // little-endian pairs, so the fields land at 26 and 28.
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    // Lossless: 'VP8L' + size(4) + 0x2f signature, then 14 bits of (w-1) and
    // 14 bits of (h-1) packed little-endian across bytes 21..24.
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    // Extended: 'VP8X' + size(4) + flags(4) + 24-bit little-endian (w-1),(h-1).
    if (chunk === 'VP8X' && buf.length >= 30) {
      const w = buf[24]! | (buf[25]! << 8) | (buf[26]! << 16);
      const h = buf[27]! | (buf[28]! << 8) | (buf[29]! << 16);
      return { format: 'webp', width: w + 1, height: h + 1 };
    }
  }
  return null;
}
