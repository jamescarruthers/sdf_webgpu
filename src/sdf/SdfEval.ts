// CPU mirror of the WGSL scene interpreter in src/shaders/common/scene.wgsl.
// Used by the clipmap baker (and the legacy BrickAtlas) to classify and bake
// bricks without a GPU round-trip. The semantics MUST match the WGSL version
// exactly — the golden test suite compares their outputs at sample points.

import { OP, type Record8 } from "./Primitives";
import type { Vec3 } from "../util/math";

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length3(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z);
}

function sdSphere(p: Vec3, r: number): number {
  return length3(p[0], p[1], p[2]) - r;
}

function sdBox(p: Vec3, b: Vec3): number {
  const qx = Math.abs(p[0]) - b[0];
  const qy = Math.abs(p[1]) - b[1];
  const qz = Math.abs(p[2]) - b[2];
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  const outside = length3(ox, oy, oz);
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside;
}

function sdRoundBox(p: Vec3, b: Vec3, r: number): number {
  return sdBox(p, [b[0] - r, b[1] - r, b[2] - r]) - r;
}

function sdCapsule(p: Vec3, a: Vec3, b: Vec3, r: number): number {
  const pax = p[0] - a[0], pay = p[1] - a[1], paz = p[2] - a[2];
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const baba = Math.max(bax * bax + bay * bay + baz * baz, 1e-8);
  const paba = pax * bax + pay * bay + paz * baz;
  const h = Math.max(0, Math.min(1, paba / baba));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return length3(dx, dy, dz) - r;
}

function sdPlaneY(p: Vec3, h: number): number {
  return p[1] - h;
}

function sdTorus(p: Vec3, R: number, r: number): number {
  const qx = Math.hypot(p[0], p[2]) - R;
  return Math.hypot(qx, p[1]) - r;
}

function opUnion(a: number, b: number): number { return Math.min(a, b); }
function opSubtract(a: number, b: number): number { return Math.max(a, -b); }
function opIntersect(a: number, b: number): number { return Math.max(a, b); }

function opSmoothUnion(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / Math.max(k, 1e-6)));
  return (1 - h) * b + h * a - k * h * (1 - h);
}

function opSmoothSubtract(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 - (0.5 * (b + a)) / Math.max(k, 1e-6)));
  return (1 - h) * a + h * -b + k * h * (1 - h);
}

function opSmoothIntersect(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 - (0.5 * (b - a)) / Math.max(k, 1e-6)));
  return (1 - h) * b + h * a + k * h * (1 - h);
}

const STACK = new Float64Array(64);

export function evalSceneJS(records: readonly Record8[], p: Vec3): number {
  let sp = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const op = rec[0];
    switch (op) {
      case OP.SPHERE: {
        const c: Vec3 = [rec[1], rec[2], rec[3]];
        STACK[sp++] = sdSphere(sub(p, c), rec[4]);
        break;
      }
      case OP.BOX: {
        const c: Vec3 = [rec[1], rec[2], rec[3]];
        const e: Vec3 = [rec[4], rec[5], rec[6]];
        STACK[sp++] = sdBox(sub(p, c), e);
        break;
      }
      case OP.ROUNDBOX: {
        const c: Vec3 = [rec[1], rec[2], rec[3]];
        const e: Vec3 = [rec[4], rec[5], rec[6]];
        STACK[sp++] = sdRoundBox(sub(p, c), e, rec[7]);
        break;
      }
      case OP.CAPSULE: {
        const a0: Vec3 = [rec[1], rec[2], rec[3]];
        const b0: Vec3 = [rec[4], rec[5], rec[6]];
        STACK[sp++] = sdCapsule(p, a0, b0, rec[7]);
        break;
      }
      case OP.PLANE_Y: {
        STACK[sp++] = sdPlaneY(p, rec[1]);
        break;
      }
      case OP.TORUS: {
        const c: Vec3 = [rec[1], rec[2], rec[3]];
        STACK[sp++] = sdTorus(sub(p, c), rec[4], rec[5]);
        break;
      }
      case OP.UNION:
        if (sp >= 2) { STACK[sp - 2] = opUnion(STACK[sp - 2]!, STACK[sp - 1]!); sp--; }
        break;
      case OP.SUBTRACT:
        if (sp >= 2) { STACK[sp - 2] = opSubtract(STACK[sp - 2]!, STACK[sp - 1]!); sp--; }
        break;
      case OP.INTERSECT:
        if (sp >= 2) { STACK[sp - 2] = opIntersect(STACK[sp - 2]!, STACK[sp - 1]!); sp--; }
        break;
      case OP.SMOOTH_UNION:
        if (sp >= 2) { STACK[sp - 2] = opSmoothUnion(STACK[sp - 2]!, STACK[sp - 1]!, rec[1]); sp--; }
        break;
      case OP.SMOOTH_SUBTRACT:
        if (sp >= 2) { STACK[sp - 2] = opSmoothSubtract(STACK[sp - 2]!, STACK[sp - 1]!, rec[1]); sp--; }
        break;
      case OP.SMOOTH_INTERSECT:
        if (sp >= 2) { STACK[sp - 2] = opSmoothIntersect(STACK[sp - 2]!, STACK[sp - 1]!, rec[1]); sp--; }
        break;
    }
  }
  return sp > 0 ? STACK[0]! : 1e20;
}
