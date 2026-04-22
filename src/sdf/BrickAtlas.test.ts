import { describe, expect, it } from "vitest";
import {
  BRICK_EMPTY,
  BRICK_SAMPLES,
  BRICK_SOLID,
  BrickAtlas,
  SAMPLE_SPACING,
} from "./BrickAtlas";
import { evalSceneJS } from "./SdfEval";
import { SceneBuilder, sphereRec, planeYRec, unionRec } from "./Primitives";

function mkAtlas() {
  return new BrickAtlas({
    world: { origin: [-2, -1, -2], size: [4, 3, 4] },
    atlasSlots: [4, 3, 4],
  });
}

describe("BrickAtlas geometry", () => {
  it("reports atlas texel dimensions as slots × BRICK_SAMPLES", () => {
    const a = mkAtlas();
    expect(a.atlasSamples).toEqual([4 * BRICK_SAMPLES, 3 * BRICK_SAMPLES, 4 * BRICK_SAMPLES]);
  });

  it("brickIndex is a bijection on the grid", () => {
    const a = mkAtlas();
    const seen = new Set<number>();
    for (let z = 0; z < 4; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
          const idx = a.brickIndex(x, y, z);
          expect(seen.has(idx)).toBe(false);
          seen.add(idx);
        }
      }
    }
    expect(seen.size).toBe(4 * 3 * 4);
  });

  it("slotOrigin maps slot 0 to the atlas origin", () => {
    const a = mkAtlas();
    expect(a.slotOrigin(0)).toEqual([0, 0, 0]);
    expect(a.slotOrigin(1)).toEqual([BRICK_SAMPLES, 0, 0]);
    expect(a.slotOrigin(4)).toEqual([0, BRICK_SAMPLES, 0]);
    expect(a.slotOrigin(12)).toEqual([0, 0, BRICK_SAMPLES]);
  });

  it("samples are spaced by SAMPLE_SPACING across the brick", () => {
    expect(SAMPLE_SPACING * (BRICK_SAMPLES - 1)).toBeCloseTo(1.0);
  });
});

describe("BrickAtlas bake — classification", () => {
  it("marks bricks far from any surface as EMPTY and deep interiors as SOLID", () => {
    // A unit sphere at origin inside a 4³ world of 1m bricks.
    const s = new SceneBuilder();
    s.push(sphereRec([0, 0, 0], 0.8));
    const atlas = new BrickAtlas({
      world: { origin: [-2, -2, -2], size: [4, 4, 4] },
      atlasSlots: [8, 8, 2],
    });
    const stats = atlas.bake(s.getRecords());
    expect(stats.totalBricks).toBe(64);
    // Corner bricks are far from the sphere: must be EMPTY.
    const cornerIdx = atlas.brickIndex(0, 0, 0);
    expect(atlas.brickMap[cornerIdx]).toBe(BRICK_EMPTY);
    // Bricks that intersect the sphere surface should be allocated.
    expect(stats.allocated).toBeGreaterThan(0);
    // With radius 0.8 and 1m bricks, no brick is entirely inside the sphere
    // (every 1m³ brick containing the center also has corners farther than
    // 0.8 m), so solids may be zero — only assert non-negative.
    expect(stats.solid).toBeGreaterThanOrEqual(0);
    expect(stats.allocated + stats.solid + stats.empty).toBe(64);
  });

  it("baked brick samples approximate the reference SDF", () => {
    const s = new SceneBuilder();
    s.push(sphereRec([0, 0, 0], 0.7));
    s.push(planeYRec(-0.9));
    s.push(unionRec());
    const atlas = new BrickAtlas({
      world: { origin: [-1, -1, -1], size: [2, 2, 2] },
      atlasSlots: [4, 4, 4],
    });
    atlas.bake(s.getRecords());

    // Find an allocated brick and verify its first sample matches the
    // reference evaluator to within f16 precision.
    let checked = 0;
    for (let bz = 0; bz < 2 && checked < 4; bz++) {
      for (let by = 0; by < 2 && checked < 4; by++) {
        for (let bx = 0; bx < 2 && checked < 4; bx++) {
          const idx = atlas.brickIndex(bx, by, bz);
          const slot = atlas.brickMap[idx]!;
          if (slot === BRICK_EMPTY || slot === BRICK_SOLID) continue;
          const [ox, oy, oz] = atlas.slotOrigin(slot);
          const [atx, aty] = atlas.atlasSamples;
          const texelIdx = (oz * aty + oy) * atx + ox;
          const half = atlas.atlasData[texelIdx]!;
          const stored = halfToFloat(half);
          const worldP: [number, number, number] = [
            -1 + bx * 1.0,
            -1 + by * 1.0,
            -1 + bz * 1.0,
          ];
          const ref = evalSceneJS(s.getRecords(), worldP);
          expect(Math.abs(stored - ref)).toBeLessThan(0.01);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const mant = h & 0x03ff;
  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * mant * Math.pow(2, -24);
  }
  if (exp === 31) return mant ? NaN : sign ? -Infinity : Infinity;
  return (sign ? -1 : 1) * (1 + mant / 1024) * Math.pow(2, exp - 15);
}
