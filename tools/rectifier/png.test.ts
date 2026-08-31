// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The PNG codec, exercised without the network. `smoke.test.ts` runs the same
// round trip against a real catalog scan when one is present; this one always
// runs, because a delta image that cannot be written is evidence that does not
// exist.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CANONICAL_H, CANONICAL_W } from './constants.ts';
import { blankCanonical, diffPair } from './diff.ts';
import { decodePng, encodePng } from './png.ts';
import { syntheticCard } from './synthetic.ts';

describe('png codec', () => {
  it('round-trips an RGBA raster byte for byte', () => {
    const img = syntheticCard(64, 91);
    const round = decodePng(encodePng(img));
    assert.equal(round.width, 64);
    assert.equal(round.height, 91);
    assert.deepEqual(round.rgba, img.rgba);
  });

  it('round-trips a canonical raster', () => {
    const img = blankCanonical();
    const round = decodePng(encodePng(img));
    assert.equal(round.width, CANONICAL_W);
    assert.equal(round.height, CANONICAL_H);
    assert.deepEqual(round.rgba, img.rgba);
  });

  it('writes a delta map that reads back identically', () => {
    const a = syntheticCard(CANONICAL_W, CANONICAL_H);
    const b = syntheticCard(CANONICAL_W, CANONICAL_H);
    const { delta } = diffPair(a, b);
    assert.deepEqual(decodePng(encodePng(delta)).rgba, delta.rgba);
  });

  it('preserves alpha, which a three-channel shortcut would drop', () => {
    const img = { width: 2, height: 1, rgba: new Uint8Array([1, 2, 3, 4, 250, 251, 252, 0]) };
    assert.deepEqual(decodePng(encodePng(img)).rgba, img.rgba);
  });

  it('emits a real PNG signature and an IEND', () => {
    const buf = encodePng(syntheticCard(4, 4));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(buf.subarray(buf.length - 8, buf.length - 4).toString('latin1'), 'IEND');
  });

  it('rejects a non-PNG', () => {
    assert.throws(() => decodePng(Buffer.from('not a png at all, really')), /not a PNG/);
  });

  it('rejects a length mismatch rather than writing garbage', () => {
    assert.throws(() => encodePng({ width: 4, height: 4, rgba: new Uint8Array(3) }), /length mismatch/);
  });
});
