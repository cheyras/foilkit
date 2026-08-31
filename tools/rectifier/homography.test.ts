// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CANONICAL_H, CANONICAL_W, canonicalCorners } from './constants.ts';
import {
  IDENTITY,
  type Mat3,
  type Point,
  type Quad,
  applyHomography,
  deserializeHomography,
  homographyFromCorrespondences,
  homographyToCanonical,
  invertMat3,
  multiplyMat3,
  normalizeMat3,
  orientCorners,
  serializeHomography,
} from './homography.ts';
import { tiltedQuad } from './synthetic.ts';

function maxAbsDiff(a: Mat3, b: Mat3): number {
  let m = 0;
  for (let i = 0; i < 9; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

describe('matrix algebra', () => {
  it('multiplies by the identity without change', () => {
    const m: Mat3 = [2, 0.3, -5, 0.1, 1.7, 12, 0.0004, -0.0002, 1];
    assert.equal(maxAbsDiff(multiplyMat3(m, IDENTITY), m), 0);
    assert.equal(maxAbsDiff(multiplyMat3(IDENTITY, m), m), 0);
  });

  it('round-trips H · H⁻¹ ≈ I', () => {
    const H = homographyToCanonical(tiltedQuad());
    const back = multiplyMat3(H, invertMat3(H));
    const err = maxAbsDiff(normalizeMat3(back), IDENTITY);
    assert.ok(err < 1e-9, `H·H⁻¹ deviated from I by ${err}`);

    const forth = multiplyMat3(invertMat3(H), H);
    assert.ok(maxAbsDiff(normalizeMat3(forth), IDENTITY) < 1e-9);
  });

  it('refuses a singular matrix', () => {
    assert.throws(() => invertMat3([1, 2, 3, 2, 4, 6, 7, 8, 9]), /singular/);
  });

  it('is scale-invariant after normalisation', () => {
    const H = homographyToCanonical(tiltedQuad());
    const scaled = H.map((v) => v * -3.7) as unknown as Mat3;
    assert.ok(maxAbsDiff(normalizeMat3(scaled), normalizeMat3(H)) < 1e-9);
  });
});

describe('4-point DLT', () => {
  const quad = tiltedQuad();

  it('maps each source corner exactly onto its destination', () => {
    const H = homographyToCanonical(quad);
    const dst = canonicalCorners();
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(H, quad[i]!);
      assert.ok(
        Math.hypot(p[0] - dst[i]![0], p[1] - dst[i]![1]) < 1e-7,
        `corner ${i} landed at ${p} rather than ${dst[i]}`,
      );
    }
  });

  it('inverts back to the detected corners', () => {
    const H = homographyToCanonical(quad);
    const inv = invertMat3(H);
    const dst = canonicalCorners();
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(inv, dst[i]!);
      assert.ok(Math.hypot(p[0] - quad[i]![0], p[1] - quad[i]![1]) < 1e-7);
    }
  });

  it('survives large coordinates — the Hartley normalisation earning its keep', () => {
    // A 4032×3024 phone photo. Without normalisation the 8×8 solve loses digits
    // at this magnitude; the corner residual is the tell.
    const big: Point[] = [
      [980, 640],
      [3050, 810],
      [3210, 2600],
      [800, 2410],
    ];
    const H = homographyFromCorrespondences(big, canonicalCorners());
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(H, big[i]!);
      const d = canonicalCorners()[i]!;
      assert.ok(Math.hypot(p[0] - d[0], p[1] - d[1]) < 1e-6);
    }
  });

  it('rejects a degenerate quad', () => {
    const collinear: Point[] = [
      [0, 0],
      [10, 10],
      [20, 20],
      [30, 30],
    ];
    assert.throws(() => homographyFromCorrespondences(collinear, canonicalCorners()), /degenerate/);
  });

  it('rejects the wrong number of points', () => {
    assert.throws(
      () => homographyFromCorrespondences([[0, 0], [1, 0], [1, 1]], canonicalCorners()),
      /exactly 4/,
    );
  });
});

describe('serialisation', () => {
  it('round-trips through the frame registry form', () => {
    const H = homographyToCanonical(tiltedQuad());
    const rows = serializeHomography(H);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.length === 3));
    assert.equal(rows[2]![2], 1, 'the serialised form is normalised to h22 = 1');
    assert.ok(maxAbsDiff(deserializeHomography(rows), normalizeMat3(H)) < 1e-12);
  });

  it('survives a JSON round trip, which is the actual storage path', () => {
    const H = homographyToCanonical(tiltedQuad());
    const parsed = deserializeHomography(JSON.parse(JSON.stringify(serializeHomography(H))));
    const p = applyHomography(parsed, tiltedQuad()[0]);
    assert.ok(Math.hypot(p[0], p[1]) < 1e-6);
  });

  it('rejects a malformed matrix', () => {
    assert.throws(() => deserializeHomography([[1, 2], [3, 4]]), /3×3/);
    assert.throws(
      () => deserializeHomography([[1, 2, 3], [4, 5, 6], [7, 8, Number.NaN]]),
      /finite/,
    );
  });
});

describe('orientation resolution', () => {
  const tl: Point = [420, 250];
  const tr: Point = [1060, 300];
  const br: Point = [1120, 1300];
  const bl: Point = [300, 1230];
  const truth = [tl, tr, br, bl];

  function assertResolvesToTruth(input: Point[], label: string) {
    const { quad } = orientCorners(input, 'auto');
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(quad[i], truth[i], `${label}: corner ${i}`);
    }
  }

  it('leaves an already-correct quad alone', () => {
    assertResolvesToTruth([tl, tr, br, bl], 'identity');
    assert.equal(orientCorners([tl, tr, br, bl]).steps, 0);
  });

  it('recovers every cyclic rotation of the detector output', () => {
    assertResolvesToTruth([tr, br, bl, tl], 'rot1');
    assertResolvesToTruth([br, bl, tl, tr], 'rot2');
    assertResolvesToTruth([bl, tl, tr, br], 'rot3');
  });

  it('recovers a counter-clockwise detection', () => {
    assertResolvesToTruth([bl, br, tr, tl], 'reversed');
    assert.equal(orientCorners([bl, br, tr, tl]).reversed, true);
    assert.equal(orientCorners([tl, tr, br, bl]).reversed, false);
  });

  it('uses the aspect to reject a sideways reading', () => {
    // 90° out: the aspect term says the short edge is not the top edge.
    const { quad } = orientCorners([tr, br, bl, tl], 'auto');
    const topLen = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
    const sideLen = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    assert.ok(topLen < sideLen, 'the resolved top edge must be the short edge');
  });

  it('uses uprightness to reject the 180° flip, which the aspect cannot see', () => {
    const { quad } = orientCorners([br, bl, tl, tr], 'auto');
    assert.ok(quad[0][1] < quad[3][1], 'the resolved top-left must sit above the bottom-left');
  });

  it('honours an explicit override verbatim', () => {
    const given = [bl, tl, tr, br] as unknown as Quad;
    const asGiven = orientCorners(given, 'as-given');
    assert.deepEqual(asGiven.quad, given);
    assert.equal(asGiven.steps, 0);

    // rotate90 shifts by one, which is what turns this particular list upright.
    assert.deepEqual(orientCorners(given, 'rotate90').quad, [tl, tr, br, bl]);
    assert.deepEqual(orientCorners(given, 'rotate180').quad, [tr, br, bl, tl]);
    assert.deepEqual(orientCorners(given, 'rotate270').quad, [br, bl, tl, tr]);
  });

  it('rejects anything that is not four corners', () => {
    assert.throws(() => orientCorners([tl, tr, br]), /exactly 4/);
  });
});

describe('canonical destination', () => {
  it('targets 504×704 by default', () => {
    const H = homographyToCanonical(tiltedQuad());
    const br = applyHomography(H, tiltedQuad()[2]);
    assert.ok(Math.abs(br[0] - CANONICAL_W) < 1e-7);
    assert.ok(Math.abs(br[1] - CANONICAL_H) < 1e-7);
  });
});
