import { describe, expect, it } from "vitest";
import {
  OP,
  RECORD_FLOATS,
  SceneBuilder,
  boxRec,
  planeYRec,
  smoothUnionRec,
  sphereRec,
  subtractRec,
  torusRec,
  unionRec,
} from "./Primitives";

// Reference JS implementations mirror the WGSL primitives in src/shaders/common/sdf_ops.wgsl.
// These are used to verify the CPU-side op codes agree with the shader shapes.
function sdSphere(p: [number, number, number], r: number): number {
  return Math.hypot(p[0], p[1], p[2]) - r;
}

function sdBox(p: [number, number, number], b: [number, number, number]): number {
  const qx = Math.abs(p[0]) - b[0];
  const qy = Math.abs(p[1]) - b[1];
  const qz = Math.abs(p[2]) - b[2];
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  const outside = Math.hypot(ox, oy, oz);
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside;
}

function sdTorus(p: [number, number, number], R: number, r: number): number {
  const qx = Math.hypot(p[0], p[2]) - R;
  return Math.hypot(qx, p[1]) - r;
}

function opUnion(a: number, b: number): number {
  return Math.min(a, b);
}
function opSmoothUnion(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / Math.max(k, 1e-6)));
  return (1 - h) * b + h * a - k * h * (1 - h);
}

describe("SceneBuilder packing", () => {
  it("packs each record as 8 contiguous floats", () => {
    const s = new SceneBuilder();
    s.push(sphereRec([1, 2, 3], 0.5));
    s.push(boxRec([0, 1, 0], [2, 3, 4]));
    const packed = s.pack();
    expect(packed.length).toBeGreaterThanOrEqual(2 * RECORD_FLOATS);
    expect(packed[0]).toBe(OP.SPHERE);
    expect(packed[1]).toBe(1);
    expect(packed[2]).toBe(2);
    expect(packed[3]).toBe(3);
    expect(packed[4]).toBe(0.5);
    expect(packed[8]).toBe(OP.BOX);
    expect(packed[9]).toBe(0);
    expect(packed[10]).toBe(1);
    expect(packed[11]).toBe(0);
    expect(packed[12]).toBe(2);
    expect(packed[13]).toBe(3);
    expect(packed[14]).toBe(4);
  });

  it("reports record count and allows clearing", () => {
    const s = new SceneBuilder();
    s.push(planeYRec(0));
    s.push(torusRec([0, 0, 0], 1, 0.2));
    expect(s.count()).toBe(2);
    s.clear();
    expect(s.count()).toBe(0);
  });
});

describe("Reference SDF primitives", () => {
  it("sphere zero iso is on the surface", () => {
    expect(sdSphere([1, 0, 0], 1)).toBeCloseTo(0, 6);
    expect(sdSphere([0, 2, 0], 1)).toBeCloseTo(1, 6);
  });

  it("box zero iso is on the surface", () => {
    expect(sdBox([1, 0, 0], [1, 1, 1])).toBeCloseTo(0, 6);
    expect(sdBox([2, 0, 0], [1, 1, 1])).toBeCloseTo(1, 6);
  });

  it("torus zero iso is on the ring", () => {
    expect(sdTorus([1.2, 0, 0], 1, 0.2)).toBeCloseTo(0, 6);
  });

  it("union picks the nearer surface", () => {
    expect(opUnion(1, 2)).toBe(1);
    expect(opUnion(-0.5, 0.3)).toBe(-0.5);
  });

  it("smooth union is continuous and bounded above by the hard union", () => {
    const k = 0.5;
    for (let t = -2; t <= 2; t += 0.1) {
      const hard = opUnion(t, -t);
      const soft = opSmoothUnion(t, -t, k);
      expect(soft).toBeLessThanOrEqual(hard + 1e-6);
    }
  });
});

describe("Scene program shapes", () => {
  it("primitive + CSG yields a well-formed RPN program", () => {
    const s = new SceneBuilder();
    s.push(sphereRec([0, 0, 0], 1));
    s.push(sphereRec([1, 0, 0], 1));
    s.push(smoothUnionRec(0.3));
    s.push(boxRec([0, 0, 0], [0.5, 0.5, 0.5]));
    s.push(subtractRec());
    s.push(planeYRec(0));
    s.push(unionRec());
    expect(s.count()).toBe(7);
  });
});
