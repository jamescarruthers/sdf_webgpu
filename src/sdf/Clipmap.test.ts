import { describe, expect, it } from "vitest";
import {
  BRICK_EMPTY,
  BRICK_SOLID,
  Clipmap,
  ringLinearForTest,
} from "./Clipmap";
import { SceneBuilder, planeYRec, sphereRec, unionRec } from "./Primitives";

describe("ringLinear — toroidal addressing", () => {
  const rs: [number, number, number] = [8, 8, 8];

  it("is identity inside the ring", () => {
    expect(ringLinearForTest(0, 0, 0, rs)).toBe(0);
    expect(ringLinearForTest(1, 0, 0, rs)).toBe(1);
    expect(ringLinearForTest(0, 1, 0, rs)).toBe(8);
    expect(ringLinearForTest(0, 0, 1, rs)).toBe(64);
  });

  it("wraps negative coordinates like a positive modulus", () => {
    expect(ringLinearForTest(-1, 0, 0, rs)).toBe(ringLinearForTest(7, 0, 0, rs));
    expect(ringLinearForTest(-8, -16, -24, rs)).toBe(0);
  });

  it("wraps every 8 cells along each axis", () => {
    expect(ringLinearForTest(9, 0, 0, rs)).toBe(ringLinearForTest(1, 0, 0, rs));
    expect(ringLinearForTest(0, 17, 0, rs)).toBe(ringLinearForTest(0, 1, 0, rs));
  });
});

describe("Clipmap recenter + flush", () => {
  function scene() {
    const s = new SceneBuilder();
    s.push(planeYRec(0));
    s.push(sphereRec([0, 1, 0], 0.8));
    s.push(unionRec());
    return s.getRecords();
  }

  it("populates every ring cell on first recenter and drains the queue", () => {
    const c = new Clipmap({
      baseBrickWorld: 1.0,
      ringBricks: [8, 4, 8],
      levels: 3,
      atlasSlots: [8, 8, 4],
    });
    c.recenter([0, 0, 0]);
    // 3 levels × 8*4*8 = 768 ring cells must be enqueued for the first bake.
    expect(c.queueDepth()).toBe(3 * 8 * 4 * 8);

    let processed = 0;
    while (c.queueDepth() > 0) {
      processed += c.flush(scene(), 2000);
    }
    expect(processed).toBe(3 * 8 * 4 * 8);
    expect(c.queueDepth()).toBe(0);

    // After bake, every ring cell must hold EMPTY, SOLID, or a real slot.
    let allocated = 0;
    for (const L of c.levels) {
      for (let i = 0; i < L.brickCount; i++) {
        const entry = L.brickMap[i]!;
        const ok = entry === BRICK_EMPTY || entry === BRICK_SOLID || entry < c.slotCapacity;
        expect(ok).toBe(true);
        if (entry !== BRICK_EMPTY && entry !== BRICK_SOLID) allocated++;
      }
    }
    expect(allocated).toBeGreaterThan(0);
    expect(allocated).toBe(c.totalAllocated());
  });

  it("only re-evaluates the incoming strip after a small camera move", () => {
    const c = new Clipmap({
      baseBrickWorld: 1.0,
      ringBricks: [8, 4, 8],
      levels: 1,
      atlasSlots: [8, 8, 4],
    });
    c.recenter([0, 0, 0]);
    while (c.queueDepth() > 0) c.flush(scene(), 2000);

    // Shift the camera exactly one level-0 brick along +X.
    c.recenter([1, 0, 0]);
    // A shift of one brick invalidates one face of the 8×4×8 ring = 32 cells.
    expect(c.queueDepth()).toBe(4 * 8);
    const processed = c.flush(scene(), 2000);
    expect(processed).toBe(4 * 8);
    expect(c.queueDepth()).toBe(0);
  });

  it("recycles atlas slots when a brick leaves the ring", () => {
    const c = new Clipmap({
      baseBrickWorld: 1.0,
      ringBricks: [4, 2, 4],
      levels: 1,
      atlasSlots: [4, 4, 2],
    });
    c.recenter([0, 0, 0]);
    while (c.queueDepth() > 0) c.flush(scene(), 2000);
    const allocatedBefore = c.totalAllocated();
    expect(allocatedBefore).toBeGreaterThan(0);

    // Move far enough that every cell is invalidated. Subsequent recenter +
    // flush should free the old slots and reuse them.
    c.recenter([100, 0, 100]);
    while (c.queueDepth() > 0) c.flush(scene(), 2000);
    expect(c.totalAllocated()).toBeLessThanOrEqual(c.slotCapacity);
  });

  it("respects the per-call brick budget", () => {
    const c = new Clipmap({
      baseBrickWorld: 1.0,
      ringBricks: [8, 4, 8],
      levels: 2,
      atlasSlots: [8, 8, 4],
    });
    c.recenter([0, 0, 0]);
    const before = c.queueDepth();
    const processed = c.flush(scene(), 50);
    expect(processed).toBe(50);
    expect(c.queueDepth()).toBe(before - 50);
  });
});
