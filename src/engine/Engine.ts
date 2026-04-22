import { requestGPU, resizeCanvas, type GPUContext } from "../util/gpu";
import { RECORD_BYTES, type SceneBuilder, type Record8 } from "../sdf/Primitives";
import { BRICK_SAMPLES, Clipmap, type ClipmapConfig } from "../sdf/Clipmap";
import uniformsSrc from "../shaders/common/uniforms.wgsl?raw";
import sdfOpsSrc from "../shaders/common/sdf_ops.wgsl?raw";
import sceneSrc from "../shaders/common/scene.wgsl?raw";
import clipmapSrc from "../shaders/common/clipmap.wgsl?raw";
import sharedSrc from "../shaders/common/shared.wgsl?raw";
import raymarchAnalyticSrc from "../shaders/raymarch.wgsl?raw";
import raymarchClipmapSrc from "../shaders/raymarch_clipmap.wgsl?raw";
import { Camera } from "./Camera";
import type { Input } from "./Input";

// Must match the `Uniforms` struct in uniforms.wgsl — 6 vec4<f32> = 24 floats.
const UNIFORM_FLOATS = 24;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

// ClipmapParams (globals): 3 × vec4 = 48 bytes.
const CLIPMAP_PARAMS_BYTES = 48;
// LevelParams: 4 × vec4 = 64 bytes per level.
const LEVEL_PARAMS_BYTES = 64;

export type RenderMode = "analytic" | "clipmap";

export interface EngineStats {
  sceneRecords: number;
  debugMode: string;
  resolution: [number, number];
  mode: RenderMode;
  clipmapAllocated: number;
  clipmapCapacity: number;
  clipmapQueueDepth: number;
  clipmapLevelCounts: number[];
  lastBakeMs: number;
}

interface AnalyticPipeline {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
}

interface ClipmapPipeline {
  pipeline: GPURenderPipeline;
  uniformBindGroup: GPUBindGroup;
  clipmapBindGroup: GPUBindGroup;
}

export class Engine {
  readonly gpu: GPUContext;
  readonly camera = new Camera();

  private readonly uniformBuffer: GPUBuffer;
  private readonly sceneHeaderBuffer: GPUBuffer;
  private sceneRecordBuffer: GPUBuffer;
  private sceneRecordCapacity = 0;
  private sceneRecordCount = 0;
  private sceneRecords: Record8[] = [];

  private analytic: AnalyticPipeline;
  private clipmapPipeline: ClipmapPipeline | null = null;

  private readonly analyticBGL: GPUBindGroupLayout;
  private readonly clipmapUniformBGL: GPUBindGroupLayout;
  private readonly clipmapBGL: GPUBindGroupLayout;

  private readonly analyticModule: GPUShaderModule;
  private readonly clipmapModule: GPUShaderModule;

  private clipmap: Clipmap | null = null;
  private clipmapConfig: ClipmapConfig | null = null;
  private clipmapParamsBuffer: GPUBuffer | null = null;
  private levelParamsBuffer: GPUBuffer | null = null;
  private brickMapBuffer: GPUBuffer | null = null;
  private atlasTexture: GPUTexture | null = null;
  private atlasSampler: GPUSampler | null = null;

  // Per-frame streaming budget.
  perFrameBrickBudget = 512;
  lastBakeMs = 0;
  lastStreamedBricks = 0;

  private mode: RenderMode = "clipmap";
  private maxSteps = 160;
  private maxDist = 400;
  private epsilon = 0.001;
  private debugMode: 0 | 1 | 2 = 0;

  constructor(gpu: GPUContext) {
    this.gpu = gpu;
    const { device, format } = gpu;

    this.uniformBuffer = device.createBuffer({
      label: "raymarch.uniforms",
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sceneHeaderBuffer = device.createBuffer({
      label: "scene.header",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.sceneRecordCapacity = 256;
    this.sceneRecordBuffer = device.createBuffer({
      label: "scene.records",
      size: this.sceneRecordCapacity * RECORD_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const analyticSrc = [uniformsSrc, sdfOpsSrc, sceneSrc, sharedSrc, raymarchAnalyticSrc].join("\n");
    this.analyticModule = device.createShaderModule({ label: "raymarch.analytic", code: analyticSrc });

    const clipmapShader = [uniformsSrc, clipmapSrc, sharedSrc, raymarchClipmapSrc].join("\n");
    this.clipmapModule = device.createShaderModule({ label: "raymarch.clipmap", code: clipmapShader });

    this.analyticBGL = device.createBindGroupLayout({
      label: "analytic.bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.clipmapUniformBGL = device.createBindGroupLayout({
      label: "clipmap.uniform.bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });
    this.clipmapBGL = device.createBindGroupLayout({
      label: "clipmap.bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    const analyticLayout = device.createPipelineLayout({
      label: "analytic.layout",
      bindGroupLayouts: [this.analyticBGL],
    });
    const analyticPipeline = device.createRenderPipeline({
      label: "analytic.pipeline",
      layout: analyticLayout,
      vertex: { module: this.analyticModule, entryPoint: "vs_main" },
      fragment: { module: this.analyticModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.analytic = {
      pipeline: analyticPipeline,
      bindGroup: this.buildAnalyticBindGroup(),
    };
  }

  private buildAnalyticBindGroup(): GPUBindGroup {
    return this.gpu.device.createBindGroup({
      label: "analytic.bg",
      layout: this.analyticBGL,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.sceneHeaderBuffer } },
        { binding: 2, resource: { buffer: this.sceneRecordBuffer } },
      ],
    });
  }

  setScene(scene: SceneBuilder): void {
    this.sceneRecords = [...scene.getRecords()];
    const packed = scene.pack();
    const count = scene.count();
    const { device } = this.gpu;

    if (count > this.sceneRecordCapacity) {
      let cap = this.sceneRecordCapacity;
      while (cap < count) cap *= 2;
      this.sceneRecordBuffer.destroy();
      this.sceneRecordBuffer = device.createBuffer({
        label: "scene.records",
        size: cap * RECORD_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.sceneRecordCapacity = cap;
      this.analytic.bindGroup = this.buildAnalyticBindGroup();
    }

    const bytes = count * RECORD_BYTES;
    if (bytes > 0) {
      device.queue.writeBuffer(this.sceneRecordBuffer, 0, packed.buffer, packed.byteOffset, bytes);
    }
    const header = new Uint32Array([count, 0, 0, 0]);
    device.queue.writeBuffer(this.sceneHeaderBuffer, 0, header);
    this.sceneRecordCount = count;
  }

  /**
   * Create the clipmap and upload its static resources. Call once per scene
   * change; the per-frame `recenter + flush` runs inside `update()`.
   */
  initClipmap(config?: Partial<ClipmapConfig>): void {
    const defaults: ClipmapConfig = {
      baseBrickWorld: 1.0,
      ringBricks: [16, 8, 16],
      levels: 6,
      atlasSlots: [32, 16, 16],
    };
    const cfg: ClipmapConfig = { ...defaults, ...config };
    this.clipmapConfig = cfg;
    this.clipmap = new Clipmap(cfg);

    const { device } = this.gpu;

    if (!this.clipmapParamsBuffer) {
      this.clipmapParamsBuffer = device.createBuffer({
        label: "clipmap.params",
        size: CLIPMAP_PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const levelBytes = LEVEL_PARAMS_BYTES * cfg.levels;
    if (this.levelParamsBuffer) this.levelParamsBuffer.destroy();
    this.levelParamsBuffer = device.createBuffer({
      label: "clipmap.levels",
      size: levelBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const brickMapBytes =
      cfg.levels * cfg.ringBricks[0] * cfg.ringBricks[1] * cfg.ringBricks[2] * 4;
    if (this.brickMapBuffer) this.brickMapBuffer.destroy();
    this.brickMapBuffer = device.createBuffer({
      label: "clipmap.brickMap",
      size: brickMapBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    if (this.atlasTexture) this.atlasTexture.destroy();
    this.atlasTexture = device.createTexture({
      label: "clipmap.atlas",
      size: {
        width: this.clipmap.atlasSamples[0],
        height: this.clipmap.atlasSamples[1],
        depthOrArrayLayers: this.clipmap.atlasSamples[2],
      },
      format: "r16float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (!this.atlasSampler) {
      this.atlasSampler = device.createSampler({
        label: "clipmap.sampler",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        addressModeW: "clamp-to-edge",
      });
    }

    this.writeClipmapParams();

    if (!this.clipmapPipeline) {
      const layout = device.createPipelineLayout({
        label: "clipmap.layout",
        bindGroupLayouts: [this.clipmapUniformBGL, this.clipmapBGL],
      });
      const pipeline = device.createRenderPipeline({
        label: "clipmap.pipeline",
        layout,
        vertex: { module: this.clipmapModule, entryPoint: "vs_main" },
        fragment: { module: this.clipmapModule, entryPoint: "fs_main", targets: [{ format: this.gpu.format }] },
        primitive: { topology: "triangle-list" },
      });
      const uniformBindGroup = device.createBindGroup({
        label: "clipmap.uniform.bg",
        layout: this.clipmapUniformBGL,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      });
      const clipmapBindGroup = device.createBindGroup({
        label: "clipmap.bg",
        layout: this.clipmapBGL,
        entries: [
          { binding: 0, resource: { buffer: this.clipmapParamsBuffer! } },
          { binding: 1, resource: { buffer: this.levelParamsBuffer } },
          { binding: 2, resource: { buffer: this.brickMapBuffer } },
          { binding: 3, resource: this.atlasTexture.createView() },
          { binding: 4, resource: this.atlasSampler },
        ],
      });
      this.clipmapPipeline = { pipeline, uniformBindGroup, clipmapBindGroup };
    } else {
      this.clipmapPipeline.clipmapBindGroup = device.createBindGroup({
        label: "clipmap.bg",
        layout: this.clipmapBGL,
        entries: [
          { binding: 0, resource: { buffer: this.clipmapParamsBuffer! } },
          { binding: 1, resource: { buffer: this.levelParamsBuffer! } },
          { binding: 2, resource: { buffer: this.brickMapBuffer! } },
          { binding: 3, resource: this.atlasTexture.createView() },
          { binding: 4, resource: this.atlasSampler! },
        ],
      });
    }
  }

  /**
   * Populate the clipmap around the camera with a budgeted bake. Call once
   * after `initClipmap` to pre-warm before the first render.
   */
  warmClipmap(maxMs = 50): number {
    if (!this.clipmap) return 0;
    const t0 = performance.now();
    this.clipmap.recenter(this.camera.position);
    let processed = 0;
    while (performance.now() - t0 < maxMs && this.clipmap.queueDepth() > 0) {
      processed += this.clipmap.flush(this.sceneRecords, 256);
    }
    this.lastBakeMs = performance.now() - t0;
    this.uploadClipmapDiffs();
    return processed;
  }

  private writeClipmapParams(): void {
    if (!this.clipmap || !this.clipmapConfig || !this.clipmapParamsBuffer) return;
    const c = this.clipmap;
    const cfg = this.clipmapConfig;
    const buf = new ArrayBuffer(CLIPMAP_PARAMS_BYTES);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    // levelCount.x
    u[0] = cfg.levels;
    u[1] = 0; u[2] = 0; u[3] = 0;
    // atlasSlots.xyz, w = BRICK_SAMPLES
    u[4] = cfg.atlasSlots[0]; u[5] = cfg.atlasSlots[1]; u[6] = cfg.atlasSlots[2]; u[7] = BRICK_SAMPLES;
    // atlasTexels.xyz
    f[8] = c.atlasSamples[0]; f[9] = c.atlasSamples[1]; f[10] = c.atlasSamples[2]; f[11] = 0;
    this.gpu.device.queue.writeBuffer(this.clipmapParamsBuffer, 0, buf);
  }

  /**
   * Uploads the current level params, brick map, and any dirty atlas slots.
   * Called after `recenter + flush` each frame.
   */
  private uploadClipmapDiffs(): void {
    if (!this.clipmap || !this.clipmapConfig) return;
    const { device } = this.gpu;

    // Level params: pack per-level origins, sizes, and brickMap offsets.
    const cfg = this.clipmapConfig;
    const ringCount = cfg.ringBricks[0] * cfg.ringBricks[1] * cfg.ringBricks[2];
    const levelBytes = LEVEL_PARAMS_BYTES * cfg.levels;
    const levelBuf = new ArrayBuffer(levelBytes);
    const lf = new Float32Array(levelBuf);
    const lu = new Uint32Array(levelBuf);
    const li = new Int32Array(levelBuf);
    for (let L = 0; L < this.clipmap.levels.length; L++) {
      const lv = this.clipmap.levels[L]!;
      const off = (L * LEVEL_PARAMS_BYTES) / 4;
      // origin.xyz = origin brick * brickWorld, origin.w = brickWorld
      lf[off + 0] = lv.origin.brick[0] * lv.brickWorld;
      lf[off + 1] = lv.origin.brick[1] * lv.brickWorld;
      lf[off + 2] = lv.origin.brick[2] * lv.brickWorld;
      lf[off + 3] = lv.brickWorld;
      // info.xyz = ring bricks, w = brickMap offset in u32 words
      lu[off + 4] = lv.ringBricks[0];
      lu[off + 5] = lv.ringBricks[1];
      lu[off + 6] = lv.ringBricks[2];
      lu[off + 7] = L * ringCount;
      // originBrick.xyz (i32), w unused
      li[off + 8] = lv.origin.brick[0];
      li[off + 9] = lv.origin.brick[1];
      li[off + 10] = lv.origin.brick[2];
      li[off + 11] = 0;
      // sampleSpacing.x, rest pad
      lf[off + 12] = cfg.baseBrickWorld / (BRICK_SAMPLES - 1) * Math.pow(2, L);
      lf[off + 13] = 0;
      lf[off + 14] = 0;
      lf[off + 15] = 0;
    }
    device.queue.writeBuffer(this.levelParamsBuffer!, 0, levelBuf);

    // Brick map: concatenate every level's ring into one buffer in level order.
    // Cheaper than per-level writes; ≤100 KB even at 6 levels × 16³.
    const mapBytes = cfg.levels * ringCount * 4;
    const mapBuf = new ArrayBuffer(mapBytes);
    const mapU = new Uint32Array(mapBuf);
    for (let L = 0; L < this.clipmap.levels.length; L++) {
      const lv = this.clipmap.levels[L]!;
      mapU.set(lv.brickMap, L * ringCount);
    }
    device.queue.writeBuffer(this.brickMapBuffer!, 0, mapBuf);

    // Atlas texture diffs — only slots that changed since last upload.
    if (this.clipmap.dirtySlots.size > 0 && this.atlasTexture) {
      for (const slot of this.clipmap.dirtySlots) {
        this.uploadSlot(slot);
      }
      this.clipmap.dirtySlots.clear();
    }
  }

  private uploadSlot(slot: number): void {
    if (!this.clipmap || !this.clipmapConfig || !this.atlasTexture) return;
    const cfg = this.clipmapConfig;
    const sx = slot % cfg.atlasSlots[0];
    const sy = Math.floor(slot / cfg.atlasSlots[0]) % cfg.atlasSlots[1];
    const sz = Math.floor(slot / (cfg.atlasSlots[0] * cfg.atlasSlots[1]));
    const ox = sx * BRICK_SAMPLES;
    const oy = sy * BRICK_SAMPLES;
    const oz = sz * BRICK_SAMPLES;

    // Copy the brick's 8³ samples out of the flat atlasData buffer.
    const block = new Uint16Array(new ArrayBuffer(BRICK_SAMPLES * BRICK_SAMPLES * BRICK_SAMPLES * 2));
    const [atx, aty] = this.clipmap.atlasSamples;
    for (let z = 0; z < BRICK_SAMPLES; z++) {
      for (let y = 0; y < BRICK_SAMPLES; y++) {
        for (let x = 0; x < BRICK_SAMPLES; x++) {
          const srcIdx = ((oz + z) * aty + (oy + y)) * atx + (ox + x);
          const dstIdx = (z * BRICK_SAMPLES + y) * BRICK_SAMPLES + x;
          block[dstIdx] = this.clipmap.atlasData[srcIdx]!;
        }
      }
    }
    this.gpu.device.queue.writeTexture(
      { texture: this.atlasTexture, origin: { x: ox, y: oy, z: oz } },
      block,
      { bytesPerRow: BRICK_SAMPLES * 2, rowsPerImage: BRICK_SAMPLES },
      { width: BRICK_SAMPLES, height: BRICK_SAMPLES, depthOrArrayLayers: BRICK_SAMPLES },
    );
  }

  setMode(mode: RenderMode): void {
    if (mode === "clipmap" && !this.clipmap) {
      this.initClipmap();
      this.warmClipmap();
    }
    this.mode = mode;
  }

  getMode(): RenderMode {
    return this.mode;
  }

  setDebugMode(mode: 0 | 1 | 2): void {
    this.debugMode = mode;
  }

  setRaymarchParams(p: { maxSteps?: number; maxDist?: number; epsilon?: number }): void {
    if (p.maxSteps !== undefined) this.maxSteps = p.maxSteps;
    if (p.maxDist !== undefined) this.maxDist = p.maxDist;
    if (p.epsilon !== undefined) this.epsilon = p.epsilon;
  }

  private writeUniforms(): void {
    const { canvas } = this.gpu;
    const aspect = canvas.width / Math.max(canvas.height, 1);
    const tanHalfFov = Math.tan(this.camera.fovY * 0.5);
    const f = this.camera.forward();
    const r = this.camera.right();
    const u = this.camera.up();
    const p = this.camera.position;

    const data = new Float32Array(UNIFORM_FLOATS);
    data[0] = p[0]; data[1] = p[1]; data[2] = p[2]; data[3] = performance.now() * 0.001;
    data[4] = r[0]; data[5] = r[1]; data[6] = r[2]; data[7] = tanHalfFov;
    data[8] = u[0]; data[9] = u[1]; data[10] = u[2]; data[11] = aspect;
    data[12] = f[0]; data[13] = f[1]; data[14] = f[2]; data[15] = this.debugMode;
    data[16] = this.maxSteps; data[17] = this.maxDist; data[18] = this.epsilon; data[19] = canvas.width;
    data[20] = canvas.height; data[21] = 0; data[22] = 0; data[23] = 0;

    this.gpu.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  update(input: Input, dt: number): void {
    resizeCanvas(this.gpu.canvas);
    this.camera.update(input, dt);
    const d = input.debug;
    this.debugMode = d === "steps" ? 1 : d === "normals" ? 2 : 0;

    if (this.mode === "clipmap" && this.clipmap) {
      const t0 = performance.now();
      this.clipmap.recenter(this.camera.position);
      this.lastStreamedBricks = this.clipmap.flush(this.sceneRecords, this.perFrameBrickBudget);
      this.uploadClipmapDiffs();
      this.lastBakeMs = performance.now() - t0;
    }
  }

  render(): void {
    this.writeUniforms();
    const { device, context } = this.gpu;
    const view = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder({ label: "frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" },
      ],
    });
    if (this.mode === "clipmap" && this.clipmapPipeline) {
      pass.setPipeline(this.clipmapPipeline.pipeline);
      pass.setBindGroup(0, this.clipmapPipeline.uniformBindGroup);
      pass.setBindGroup(1, this.clipmapPipeline.clipmapBindGroup);
    } else {
      pass.setPipeline(this.analytic.pipeline);
      pass.setBindGroup(0, this.analytic.bindGroup);
    }
    pass.draw(3, 1, 0, 0);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  stats(): EngineStats {
    const s = this.clipmap?.stats(this.lastStreamedBricks);
    return {
      sceneRecords: this.sceneRecordCount,
      debugMode: this.debugMode === 0 ? "off" : this.debugMode === 1 ? "steps" : "normals",
      resolution: [this.gpu.canvas.width, this.gpu.canvas.height],
      mode: this.mode,
      clipmapAllocated: s?.totalAllocated ?? 0,
      clipmapCapacity: s?.atlasCapacity ?? 0,
      clipmapQueueDepth: s?.queueDepth ?? 0,
      clipmapLevelCounts: s?.perLevelAllocated ?? [],
      lastBakeMs: this.lastBakeMs,
    };
  }
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  const gpu = await requestGPU(canvas);
  return new Engine(gpu);
}
