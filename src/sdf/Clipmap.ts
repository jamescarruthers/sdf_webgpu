// Geometry clipmap.
//
// A ring of N concentric levels centered on the camera. Level L's bricks are
// side length (BRICK_WORLD_0 * 2^L), so each level covers a cubic region 2×
// larger than the one inside it. Every level holds the same ring-size³ bricks
// in a toroidally-addressed brick-map — when the camera moves, only the strip
// of bricks that just fell out gets re-evaluated.
//
// A single atlas texture (r16float 3D) stores the samples across all levels.
// Allocation is first-fit off a free list; streaming eviction pushes slots
// back.
//
// See plan.md §4 Phase 4 for the high-level design and acceptance criteria.

import type { Vec3 } from "../util/math";
import type { Record8 } from "./Primitives";
import { evalSceneJS } from "./SdfEval";

export const BRICK_SAMPLES = 8;

export interface ClipmapConfig {
  /** Brick side length for the innermost level (level 0), in meters. */
  baseBrickWorld: number;
  /** Ring size per level. E.g. [16, 8, 16] gives a 16×8×16 ring per level. */
  ringBricks: [number, number, number];
  /** Number of clipmap levels (>= 1). */
  levels: number;
  /** Atlas size in slots per axis. atlasSlots.x*y*z is the max concurrent
   *  allocated brick count across all levels. */
  atlasSlots: [number, number, number];
}

interface LevelOrigin {
  brick: [number, number, number]; // world-brick coordinate of ring origin (min corner)
}

interface LevelState {
  readonly index: number;
  readonly brickWorld: number;
  readonly ringBricks: [number, number, number];
  readonly brickCount: number;
  /** Toroidal ring brick-map. One entry per ring cell; holds an atlas slot
   *  index or a sentinel. */
  readonly brickMap: Uint32Array<ArrayBuffer>;
  origin: LevelOrigin;
  initialized: boolean;
}

export interface ClipmapStats {
  levels: number;
  perLevelAllocated: number[];
  totalAllocated: number;
  atlasCapacity: number;
  bricksEvaluatedThisUpdate: number;
  queueDepth: number;
}

export const BRICK_EMPTY = 0xffffffff >>> 0;
export const BRICK_SOLID = 0xfffffffe >>> 0;

function ringLinear(wx: number, wy: number, wz: number, rs: [number, number, number]): number {
  const mx = ((wx % rs[0]) + rs[0]) % rs[0];
  const my = ((wy % rs[1]) + rs[1]) % rs[1];
  const mz = ((wz % rs[2]) + rs[2]) % rs[2];
  return (mz * rs[1] + my) * rs[0] + mx;
}

function toFloat16(value: number): number {
  const f32 = new Float32Array(1);
  f32[0] = value;
  const u32 = new Uint32Array(f32.buffer)[0]!;
  const sign = (u32 >>> 16) & 0x8000;
  const exp = (u32 >>> 23) & 0xff;
  const mant = u32 & 0x7fffff;
  if (exp === 0) return sign;
  if (exp === 255) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = (mant | 0x800000) >>> (1 - e);
    return sign | (m >>> 13);
  }
  return sign | (e << 10) | (mant >>> 13);
}

interface QueueEntry {
  level: number;
  bx: number; // world brick coords (in the level's brick grid)
  by: number;
  bz: number;
  ringLinear: number;
}

export class Clipmap {
  readonly config: ClipmapConfig;
  readonly levels: LevelState[];
  readonly atlasSamples: [number, number, number];
  readonly slotCapacity: number;
  readonly atlasData: Uint16Array<ArrayBuffer>;
  /** Atlas slots that were written since the last upload. */
  readonly dirtySlots: Set<number> = new Set();

  private nextSlot = 0;
  private readonly freeList: number[] = [];
  private readonly queue: QueueEntry[] = [];
  private readonly queuedSet: Set<number> = new Set(); // encoded (level, ringLinear)

  constructor(config: ClipmapConfig) {
    this.config = config;
    this.atlasSamples = [
      config.atlasSlots[0] * BRICK_SAMPLES,
      config.atlasSlots[1] * BRICK_SAMPLES,
      config.atlasSlots[2] * BRICK_SAMPLES,
    ];
    this.slotCapacity = config.atlasSlots[0] * config.atlasSlots[1] * config.atlasSlots[2];
    this.atlasData = new Uint16Array(
      new ArrayBuffer(this.atlasSamples[0] * this.atlasSamples[1] * this.atlasSamples[2] * 2),
    );
    this.levels = [];
    for (let L = 0; L < config.levels; L++) {
      const ring: [number, number, number] = [...config.ringBricks];
      const count = ring[0] * ring[1] * ring[2];
      const map = new Uint32Array(new ArrayBuffer(count * 4));
      map.fill(BRICK_EMPTY);
      this.levels.push({
        index: L,
        brickWorld: config.baseBrickWorld * Math.pow(2, L),
        ringBricks: ring,
        brickCount: count,
        brickMap: map,
        origin: { brick: [0, 0, 0] },
        initialized: false,
      });
    }
  }

  private encodeQueueKey(level: number, ringLinear: number): number {
    // Supports levels < 256 and rings up to ~16M cells.
    return level * (1 << 24) + ringLinear;
  }

  private allocSlot(): number {
    if (this.freeList.length > 0) return this.freeList.pop()!;
    if (this.nextSlot >= this.slotCapacity) return -1;
    return this.nextSlot++;
  }

  private freeSlot(slot: number): void {
    this.freeList.push(slot);
  }

  private slotOrigin(slot: number): [number, number, number] {
    const sx = slot % this.config.atlasSlots[0];
    const sy = Math.floor(slot / this.config.atlasSlots[0]) % this.config.atlasSlots[1];
    const sz = Math.floor(slot / (this.config.atlasSlots[0] * this.config.atlasSlots[1]));
    return [sx * BRICK_SAMPLES, sy * BRICK_SAMPLES, sz * BRICK_SAMPLES];
  }

  private writeBrickSamples(slot: number, samples: Float32Array): void {
    const [ox, oy, oz] = this.slotOrigin(slot);
    const [atx, aty] = this.atlasSamples;
    for (let z = 0; z < BRICK_SAMPLES; z++) {
      for (let y = 0; y < BRICK_SAMPLES; y++) {
        for (let x = 0; x < BRICK_SAMPLES; x++) {
          const srcIdx = (z * BRICK_SAMPLES + y) * BRICK_SAMPLES + x;
          const tx = ox + x;
          const ty = oy + y;
          const tz = oz + z;
          const dstIdx = (tz * aty + ty) * atx + tx;
          this.atlasData[dstIdx] = toFloat16(samples[srcIdx]!);
        }
      }
    }
    this.dirtySlots.add(slot);
  }

  /**
   * Pick each level's ring origin so that the camera is at the centre. Level L
   * always snaps to its own brick grid — the camera must move a whole brick at
   * level L before that level's origin changes, which keeps work proportional
   * to the camera speed.
   */
  private desiredOrigin(level: LevelState, camera: Vec3): [number, number, number] {
    const camBrickX = Math.floor(camera[0] / level.brickWorld);
    const camBrickY = Math.floor(camera[1] / level.brickWorld);
    const camBrickZ = Math.floor(camera[2] / level.brickWorld);
    return [
      camBrickX - Math.floor(level.ringBricks[0] / 2),
      camBrickY - Math.floor(level.ringBricks[1] / 2),
      camBrickZ - Math.floor(level.ringBricks[2] / 2),
    ];
  }

  /** World-space AABB of a given ring cell in the level's current origin. */
  brickWorldOrigin(level: LevelState, bx: number, by: number, bz: number): Vec3 {
    return [bx * level.brickWorld, by * level.brickWorld, bz * level.brickWorld];
  }

  /** Returns true if (bx, by, bz) in world-brick coords lies within the level's
   *  current ring extent. */
  private brickInRing(level: LevelState, bx: number, by: number, bz: number): boolean {
    const o = level.origin.brick;
    return (
      bx >= o[0] && bx < o[0] + level.ringBricks[0] &&
      by >= o[1] && by < o[1] + level.ringBricks[1] &&
      bz >= o[2] && bz < o[2] + level.ringBricks[2]
    );
  }

  private enqueue(level: number, bx: number, by: number, bz: number): void {
    const L = this.levels[level]!;
    const ringIdx = ringLinear(bx, by, bz, L.ringBricks);
    const key = this.encodeQueueKey(level, ringIdx);
    if (this.queuedSet.has(key)) return;
    this.queuedSet.add(key);
    this.queue.push({ level, bx, by, bz, ringLinear: ringIdx });
  }

  /** For a level whose origin has shifted from `oldOrigin` to `newOrigin`,
   *  invalidate ring cells now pointing outside the new region and enqueue
   *  every new cell for evaluation. */
  private reshift(level: LevelState, oldOrigin: [number, number, number], newOrigin: [number, number, number]): void {
    const [rx, ry, rz] = level.ringBricks;

    if (!level.initialized) {
      // Fresh population: invalidate everything, enqueue the full ring.
      for (let i = 0; i < level.brickCount; i++) {
        const entry = level.brickMap[i]!;
        if (entry !== BRICK_EMPTY && entry !== BRICK_SOLID) this.freeSlot(entry);
        level.brickMap[i] = BRICK_EMPTY;
      }
      level.origin.brick = [...newOrigin];
      for (let z = 0; z < rz; z++) {
        for (let y = 0; y < ry; y++) {
          for (let x = 0; x < rx; x++) {
            this.enqueue(level.index, newOrigin[0] + x, newOrigin[1] + y, newOrigin[2] + z);
          }
        }
      }
      level.initialized = true;
      return;
    }

    // Drop cells whose world brick is outside the new ring, freeing their
    // slots. Because toroidal addressing aliases the freed cell's slot to the
    // same ring index that will be rewritten next, we process the outgoing
    // strip before enqueuing the incoming strip.
    for (let z = 0; z < rz; z++) {
      for (let y = 0; y < ry; y++) {
        for (let x = 0; x < rx; x++) {
          const oldBX = oldOrigin[0] + x;
          const oldBY = oldOrigin[1] + y;
          const oldBZ = oldOrigin[2] + z;
          const inNew =
            oldBX >= newOrigin[0] && oldBX < newOrigin[0] + rx &&
            oldBY >= newOrigin[1] && oldBY < newOrigin[1] + ry &&
            oldBZ >= newOrigin[2] && oldBZ < newOrigin[2] + rz;
          if (inNew) continue;
          const ring = ringLinear(oldBX, oldBY, oldBZ, level.ringBricks);
          const entry = level.brickMap[ring]!;
          if (entry !== BRICK_EMPTY && entry !== BRICK_SOLID) this.freeSlot(entry);
          level.brickMap[ring] = BRICK_EMPTY;
        }
      }
    }

    level.origin.brick = [...newOrigin];

    for (let z = 0; z < rz; z++) {
      for (let y = 0; y < ry; y++) {
        for (let x = 0; x < rx; x++) {
          const newBX = newOrigin[0] + x;
          const newBY = newOrigin[1] + y;
          const newBZ = newOrigin[2] + z;
          const inOld =
            newBX >= oldOrigin[0] && newBX < oldOrigin[0] + rx &&
            newBY >= oldOrigin[1] && newBY < oldOrigin[1] + ry &&
            newBZ >= oldOrigin[2] && newBZ < oldOrigin[2] + rz;
          if (inOld) continue;
          this.enqueue(level.index, newBX, newBY, newBZ);
        }
      }
    }
  }

  /** Recentre every level on the camera, enqueuing any newly-visible bricks.
   *  Call once per frame before `flush`. */
  recenter(camera: Vec3): void {
    for (const L of this.levels) {
      const newOrigin = this.desiredOrigin(L, camera);
      const oldOrigin = L.origin.brick;
      if (
        !L.initialized ||
        newOrigin[0] !== oldOrigin[0] ||
        newOrigin[1] !== oldOrigin[1] ||
        newOrigin[2] !== oldOrigin[2]
      ) {
        this.reshift(L, oldOrigin, newOrigin);
      }
    }
  }

  /** Pop up to `maxBricks` queued evaluations and bake them into the atlas.
   *  Returns the number of bricks processed. */
  flush(records: readonly Record8[], maxBricks: number): number {
    const sampleSpacingBase = this.config.baseBrickWorld / (BRICK_SAMPLES - 1);
    const samples = new Float32Array(BRICK_SAMPLES * BRICK_SAMPLES * BRICK_SAMPLES);
    let processed = 0;

    while (processed < maxBricks && this.queue.length > 0) {
      const e = this.queue.shift()!;
      this.queuedSet.delete(this.encodeQueueKey(e.level, e.ringLinear));
      const L = this.levels[e.level]!;

      // Skip stale queue entries (camera moved again after enqueue).
      if (!this.brickInRing(L, e.bx, e.by, e.bz)) continue;

      const bw = L.brickWorld;
      const ss = sampleSpacingBase * Math.pow(2, e.level);
      const halfDiag = Math.sqrt(3) * bw * 0.5;
      const surfaceMargin = halfDiag + ss;

      const originX = e.bx * bw;
      const originY = e.by * bw;
      const originZ = e.bz * bw;
      const centerX = originX + bw * 0.5;
      const centerY = originY + bw * 0.5;
      const centerZ = originZ + bw * 0.5;

      const dCenter = evalSceneJS(records, [centerX, centerY, centerZ]);

      // Conservative early-out — the SDF interpretation has |grad| ≤ 1 for
      // analytic primitives and their unions, so any cell farther than
      // halfDiag from the surface is fully on one side.
      let finalEntry: number;
      if (dCenter > surfaceMargin) {
        finalEntry = BRICK_EMPTY;
      } else if (dCenter < -surfaceMargin) {
        finalEntry = BRICK_SOLID;
      } else {
        let minD = Infinity;
        let maxD = -Infinity;
        for (let k = 0; k < BRICK_SAMPLES; k++) {
          const pz = originZ + k * ss;
          for (let j = 0; j < BRICK_SAMPLES; j++) {
            const py = originY + j * ss;
            for (let i = 0; i < BRICK_SAMPLES; i++) {
              const px = originX + i * ss;
              const d = evalSceneJS(records, [px, py, pz]);
              samples[(k * BRICK_SAMPLES + j) * BRICK_SAMPLES + i] = d;
              if (d < minD) minD = d;
              if (d > maxD) maxD = d;
            }
          }
        }
        if (minD > 0.0) finalEntry = BRICK_EMPTY;
        else if (maxD < 0.0) finalEntry = BRICK_SOLID;
        else {
          const slot = this.allocSlot();
          if (slot < 0) {
            finalEntry = BRICK_EMPTY;
          } else {
            this.writeBrickSamples(slot, samples);
            finalEntry = slot;
          }
        }
      }

      const ringIdx = ringLinear(e.bx, e.by, e.bz, L.ringBricks);
      const prev = L.brickMap[ringIdx]!;
      if (prev !== BRICK_EMPTY && prev !== BRICK_SOLID && prev !== finalEntry) {
        this.freeSlot(prev);
      }
      L.brickMap[ringIdx] = finalEntry;
      processed++;
    }
    return processed;
  }

  queueDepth(): number {
    return this.queue.length;
  }

  totalAllocated(): number {
    return this.nextSlot - this.freeList.length;
  }

  stats(bricksEvaluatedThisUpdate: number): ClipmapStats {
    const perLevel: number[] = [];
    for (const L of this.levels) {
      let n = 0;
      for (let i = 0; i < L.brickCount; i++) {
        const e = L.brickMap[i]!;
        if (e !== BRICK_EMPTY && e !== BRICK_SOLID) n++;
      }
      perLevel.push(n);
    }
    return {
      levels: this.levels.length,
      perLevelAllocated: perLevel,
      totalAllocated: this.totalAllocated(),
      atlasCapacity: this.slotCapacity,
      bricksEvaluatedThisUpdate,
      queueDepth: this.queue.length,
    };
  }
}

export function ringLinearForTest(
  wx: number,
  wy: number,
  wz: number,
  rs: [number, number, number],
): number {
  return ringLinear(wx, wy, wz, rs);
}
