// CPU-side mirror of the opcodes defined in src/shaders/common/scene.wgsl.
// Each record is packed as two vec4<f32>s (8 floats, 32 bytes) matching the
// WGSL `SceneRecord` layout exactly.

import type { Vec3 } from "../util/math";

export const OP = {
  END: 0,
  SPHERE: 1,
  BOX: 2,
  ROUNDBOX: 3,
  CAPSULE: 4,
  PLANE_Y: 5,
  TORUS: 6,
  UNION: 16,
  SUBTRACT: 17,
  INTERSECT: 18,
  SMOOTH_UNION: 19,
  SMOOTH_SUBTRACT: 20,
  SMOOTH_INTERSECT: 21,
} as const;

export type Record8 = [number, number, number, number, number, number, number, number];

export const RECORD_FLOATS = 8;
export const RECORD_BYTES = RECORD_FLOATS * 4;

export function sphereRec(center: Vec3, radius: number): Record8 {
  return [OP.SPHERE, center[0], center[1], center[2], radius, 0, 0, 0];
}

export function boxRec(center: Vec3, extents: Vec3): Record8 {
  return [OP.BOX, center[0], center[1], center[2], extents[0], extents[1], extents[2], 0];
}

export function roundBoxRec(center: Vec3, extents: Vec3, radius: number): Record8 {
  return [OP.ROUNDBOX, center[0], center[1], center[2], extents[0], extents[1], extents[2], radius];
}

export function capsuleRec(a: Vec3, b: Vec3, radius: number): Record8 {
  return [OP.CAPSULE, a[0], a[1], a[2], b[0], b[1], b[2], radius];
}

export function planeYRec(h: number): Record8 {
  return [OP.PLANE_Y, h, 0, 0, 0, 0, 0, 0];
}

export function torusRec(center: Vec3, R: number, r: number): Record8 {
  return [OP.TORUS, center[0], center[1], center[2], R, r, 0, 0];
}

export function unionRec(): Record8 {
  return [OP.UNION, 0, 0, 0, 0, 0, 0, 0];
}

export function subtractRec(): Record8 {
  return [OP.SUBTRACT, 0, 0, 0, 0, 0, 0, 0];
}

export function intersectRec(): Record8 {
  return [OP.INTERSECT, 0, 0, 0, 0, 0, 0, 0];
}

export function smoothUnionRec(k: number): Record8 {
  return [OP.SMOOTH_UNION, k, 0, 0, 0, 0, 0, 0];
}

export function smoothSubtractRec(k: number): Record8 {
  return [OP.SMOOTH_SUBTRACT, k, 0, 0, 0, 0, 0, 0];
}

export function smoothIntersectRec(k: number): Record8 {
  return [OP.SMOOTH_INTERSECT, k, 0, 0, 0, 0, 0, 0];
}

export class SceneBuilder {
  private records: Record8[] = [];

  push(rec: Record8): this {
    this.records.push(rec);
    return this;
  }

  clear(): void {
    this.records.length = 0;
  }

  count(): number {
    return this.records.length;
  }

  /** Returns a readonly view of the records. Used by the CPU-side evaluator
   *  and the brick-atlas baker. */
  getRecords(): readonly Record8[] {
    return this.records;
  }

  /** Returns a Float32Array of length count*8, packed in WGSL vec4 layout. */
  pack(): Float32Array {
    const out = new Float32Array(Math.max(this.records.length * RECORD_FLOATS, RECORD_FLOATS));
    for (let i = 0; i < this.records.length; i++) {
      out.set(this.records[i]!, i * RECORD_FLOATS);
    }
    return out;
  }
}
