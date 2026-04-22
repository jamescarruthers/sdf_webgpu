// Brick atlas + sparse brick map.
//
// The world is partitioned into a regular grid of axis-aligned bricks. Each
// brick that contains a surface is baked into a dense 8³ block of distance
// samples stored in a 3D atlas texture. The brick map is a flat u32 buffer
// indexed by (ix, iy, iz) that either holds a sentinel or a slot index.
//
// Sample (i, j, k) of brick b is positioned at world_min + (b + i/(N-1)) * B,
// so adjacent bricks share a boundary sample — this keeps hardware trilinear
// interpolation continuous across seams.

import type { Vec3 } from "../util/math";
import type { Record8 } from "./Primitives";
import { evalSceneJS } from "./SdfEval";

export const BRICK_SAMPLES = 8;
export const BRICK_WORLD = 1.0;
export const SAMPLE_SPACING = BRICK_WORLD / (BRICK_SAMPLES - 1);

// Sentinels packed into the brick map.
export const BRICK_EMPTY = 0xffffffff >>> 0;
export const BRICK_SOLID = 0xfffffffe >>> 0;

export interface BrickWorld {
  origin: Vec3;
  size: [number, number, number]; // number of bricks on each axis
}

export interface BrickAtlasConfig {
  world: BrickWorld;
  atlasSlots: [number, number, number]; // slots per axis
}

export interface BrickBakeStats {
  totalBricks: number;
  allocated: number;
  solid: number;
  empty: number;
  atlasCapacity: number;
  atlasTexels: [number, number, number];
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

export class BrickAtlas {
  readonly config: BrickAtlasConfig;
  readonly world: BrickWorld;
  readonly atlasSamples: [number, number, number];
  readonly slotCapacity: number;

  readonly brickMap: Uint32Array<ArrayBuffer>;
  readonly atlasData: Uint16Array<ArrayBuffer>;
  private nextSlot = 0;
  private readonly freeList: number[] = [];

  stats: BrickBakeStats;

  constructor(config: BrickAtlasConfig) {
    this.config = config;
    this.world = config.world;
    this.atlasSamples = [
      config.atlasSlots[0] * BRICK_SAMPLES,
      config.atlasSlots[1] * BRICK_SAMPLES,
      config.atlasSlots[2] * BRICK_SAMPLES,
    ];
    this.slotCapacity = config.atlasSlots[0] * config.atlasSlots[1] * config.atlasSlots[2];
    const brickCount = this.world.size[0] * this.world.size[1] * this.world.size[2];
    this.brickMap = new Uint32Array(new ArrayBuffer(brickCount * 4));
    this.brickMap.fill(BRICK_EMPTY);
    const atlasTexelCount =
      this.atlasSamples[0] * this.atlasSamples[1] * this.atlasSamples[2];
    this.atlasData = new Uint16Array(new ArrayBuffer(atlasTexelCount * 2));
    this.stats = {
      totalBricks: brickCount,
      allocated: 0,
      solid: 0,
      empty: 0,
      atlasCapacity: this.slotCapacity,
      atlasTexels: this.atlasSamples,
    };
  }

  brickIndex(ix: number, iy: number, iz: number): number {
    return (iz * this.world.size[1] + iy) * this.world.size[0] + ix;
  }

  slotOrigin(slot: number): [number, number, number] {
    const sx = slot % this.config.atlasSlots[0];
    const sy = Math.floor(slot / this.config.atlasSlots[0]) % this.config.atlasSlots[1];
    const sz = Math.floor(slot / (this.config.atlasSlots[0] * this.config.atlasSlots[1]));
    return [sx * BRICK_SAMPLES, sy * BRICK_SAMPLES, sz * BRICK_SAMPLES];
  }

  private allocSlot(): number {
    if (this.freeList.length > 0) return this.freeList.pop()!;
    if (this.nextSlot >= this.slotCapacity) return -1;
    return this.nextSlot++;
  }

  freeSlot(slot: number): void {
    this.freeList.push(slot);
  }

  private writeBrick(slot: number, samples: Float32Array): void {
    const [ox, oy, oz] = this.slotOrigin(slot);
    const [atx, aty, _atz] = this.atlasSamples;
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
  }

  /** Reset to empty. */
  clear(): void {
    this.brickMap.fill(BRICK_EMPTY);
    this.atlasData.fill(0);
    this.nextSlot = 0;
    this.freeList.length = 0;
    this.stats.allocated = 0;
    this.stats.solid = 0;
    this.stats.empty = this.stats.totalBricks;
  }

  /**
   * Bake the entire scene into the atlas. Walks every world brick, classifies
   * it as EMPTY / SOLID / SURFACE, and fills surface bricks with 8³ distance
   * samples. Uses a simple Lipschitz-style bound (|grad| ≤ 1 for analytic SDFs)
   * to reject empty bricks cheaply without evaluating every sample.
   */
  bake(records: readonly Record8[]): BrickBakeStats {
    this.clear();
    const bs = BRICK_SAMPLES;
    const brickHalfDiag = Math.sqrt(3) * BRICK_WORLD * 0.5;
    const surfaceMargin = brickHalfDiag + SAMPLE_SPACING;

    const samples = new Float32Array(bs * bs * bs);
    const [wx, wy, wz] = this.world.size;

    let allocated = 0;
    let solid = 0;
    let empty = 0;

    for (let bz = 0; bz < wz; bz++) {
      for (let by = 0; by < wy; by++) {
        for (let bx = 0; bx < wx; bx++) {
          const idx = this.brickIndex(bx, by, bz);
          const centerX = this.world.origin[0] + (bx + 0.5) * BRICK_WORLD;
          const centerY = this.world.origin[1] + (by + 0.5) * BRICK_WORLD;
          const centerZ = this.world.origin[2] + (bz + 0.5) * BRICK_WORLD;
          const dCenter = evalSceneJS(records, [centerX, centerY, centerZ]);

          if (dCenter > surfaceMargin) {
            this.brickMap[idx] = BRICK_EMPTY;
            empty++;
            continue;
          }
          if (dCenter < -surfaceMargin) {
            this.brickMap[idx] = BRICK_SOLID;
            solid++;
            continue;
          }

          // Surface-candidate brick — evaluate all 8³ samples.
          const originX = this.world.origin[0] + bx * BRICK_WORLD;
          const originY = this.world.origin[1] + by * BRICK_WORLD;
          const originZ = this.world.origin[2] + bz * BRICK_WORLD;
          let minD = Infinity;
          let maxD = -Infinity;
          for (let k = 0; k < bs; k++) {
            const pz = originZ + k * SAMPLE_SPACING;
            for (let j = 0; j < bs; j++) {
              const py = originY + j * SAMPLE_SPACING;
              for (let i = 0; i < bs; i++) {
                const px = originX + i * SAMPLE_SPACING;
                const d = evalSceneJS(records, [px, py, pz]);
                samples[(k * bs + j) * bs + i] = d;
                if (d < minD) minD = d;
                if (d > maxD) maxD = d;
              }
            }
          }
          if (minD > 0.0) {
            // Fully outside after full evaluation — treat as empty.
            this.brickMap[idx] = BRICK_EMPTY;
            empty++;
            continue;
          }
          if (maxD < 0.0) {
            this.brickMap[idx] = BRICK_SOLID;
            solid++;
            continue;
          }
          const slot = this.allocSlot();
          if (slot < 0) {
            // Atlas full — fall back to treating as empty. The raymarcher
            // takes a conservative step; it will still render, just slower.
            this.brickMap[idx] = BRICK_EMPTY;
            empty++;
            continue;
          }
          this.writeBrick(slot, samples);
          this.brickMap[idx] = slot;
          allocated++;
        }
      }
    }

    this.stats = {
      totalBricks: this.stats.totalBricks,
      allocated,
      solid,
      empty,
      atlasCapacity: this.slotCapacity,
      atlasTexels: this.atlasSamples,
    };
    return this.stats;
  }
}
