import { requestGPU, resizeCanvas, type GPUContext } from "../util/gpu";
import { RECORD_BYTES, type SceneBuilder, type Record8 } from "../sdf/Primitives";
import { BrickAtlas, BRICK_SAMPLES, SAMPLE_SPACING } from "../sdf/BrickAtlas";
import type { Vec3 } from "../util/math";
import uniformsSrc from "../shaders/common/uniforms.wgsl?raw";
import sdfOpsSrc from "../shaders/common/sdf_ops.wgsl?raw";
import sceneSrc from "../shaders/common/scene.wgsl?raw";
import brickSrc from "../shaders/common/brick.wgsl?raw";
import sharedSrc from "../shaders/common/shared.wgsl?raw";
import raymarchAnalyticSrc from "../shaders/raymarch.wgsl?raw";
import raymarchAtlasSrc from "../shaders/raymarch_atlas.wgsl?raw";
import { Camera } from "./Camera";
import type { Input } from "./Input";

// Must match the `Uniforms` struct in uniforms.wgsl — 6 vec4<f32> = 24 floats.
const UNIFORM_FLOATS = 24;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

// BrickParams layout: 4 vec4s = 16 floats/u32s = 64 bytes.
const BRICK_PARAMS_BYTES = 64;

export type RenderMode = "analytic" | "atlas";

export interface EngineStats {
  sceneRecords: number;
  debugMode: string;
  resolution: [number, number];
  mode: RenderMode;
  atlasAllocated: number;
  atlasCapacity: number;
}

interface AnalyticPipeline {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
}

interface AtlasPipeline {
  pipeline: GPURenderPipeline;
  uniformBindGroup: GPUBindGroup;
  brickBindGroup: GPUBindGroup;
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
  private atlas: AtlasPipeline | null = null;

  private readonly analyticBGL: GPUBindGroupLayout;
  private readonly atlasUniformBGL: GPUBindGroupLayout;
  private readonly atlasBrickBGL: GPUBindGroupLayout;

  private readonly analyticModule: GPUShaderModule;
  private readonly atlasModule: GPUShaderModule;

  private brickAtlas: BrickAtlas | null = null;
  private brickParamsBuffer: GPUBuffer | null = null;
  private brickMapBuffer: GPUBuffer | null = null;
  private atlasTexture: GPUTexture | null = null;
  private atlasSampler: GPUSampler | null = null;

  private mode: RenderMode = "analytic";
  private maxSteps = 128;
  private maxDist = 120;
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

    const atlasSrc = [uniformsSrc, brickSrc, sharedSrc, raymarchAtlasSrc].join("\n");
    this.atlasModule = device.createShaderModule({ label: "raymarch.atlas", code: atlasSrc });

    this.analyticBGL = device.createBindGroupLayout({
      label: "analytic.bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.atlasUniformBGL = device.createBindGroupLayout({
      label: "atlas.uniform.bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });
    this.atlasBrickBGL = device.createBindGroupLayout({
      label: "atlas.brick.bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
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

    // Re-bake the atlas if we were in atlas mode.
    if (this.brickAtlas) {
      this.bakeAtlas(this.sceneRecords);
    }
  }

  /**
   * Build or rebuild the brick-atlas cache from the current scene. Idempotent.
   * Call `setMode("atlas")` afterwards to flip the render path.
   */
  bakeAtlas(records: readonly Record8[], opts?: { worldOrigin?: Vec3; worldBricks?: [number, number, number]; atlasSlots?: [number, number, number] }): void {
    const worldOrigin: Vec3 = opts?.worldOrigin ?? [-8, -2, -8];
    const worldBricks: [number, number, number] = opts?.worldBricks ?? [16, 8, 16];
    const atlasSlots: [number, number, number] = opts?.atlasSlots ?? [16, 8, 16];

    const atlas = new BrickAtlas({
      world: { origin: worldOrigin, size: worldBricks },
      atlasSlots,
    });
    atlas.bake(records);
    this.brickAtlas = atlas;

    const { device } = this.gpu;

    // (Re)create the GPU resources.
    if (this.brickMapBuffer) this.brickMapBuffer.destroy();
    this.brickMapBuffer = device.createBuffer({
      label: "brick.map",
      size: atlas.brickMap.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.brickMapBuffer, 0, atlas.brickMap);

    if (!this.brickParamsBuffer) {
      this.brickParamsBuffer = device.createBuffer({
        label: "brick.params",
        size: BRICK_PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    this.writeBrickParams();

    if (this.atlasTexture) this.atlasTexture.destroy();
    this.atlasTexture = device.createTexture({
      label: "brick.atlas",
      size: { width: atlas.atlasSamples[0], height: atlas.atlasSamples[1], depthOrArrayLayers: atlas.atlasSamples[2] },
      format: "r16float",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.atlasTexture },
      atlas.atlasData,
      {
        bytesPerRow: atlas.atlasSamples[0] * 2,
        rowsPerImage: atlas.atlasSamples[1],
      },
      {
        width: atlas.atlasSamples[0],
        height: atlas.atlasSamples[1],
        depthOrArrayLayers: atlas.atlasSamples[2],
      },
    );

    if (!this.atlasSampler) {
      this.atlasSampler = device.createSampler({
        label: "brick.atlasSampler",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        addressModeW: "clamp-to-edge",
      });
    }

    // Build atlas pipeline lazily on first use.
    if (!this.atlas) {
      const layout = device.createPipelineLayout({
        label: "atlas.layout",
        bindGroupLayouts: [this.atlasUniformBGL, this.atlasBrickBGL],
      });
      const pipeline = device.createRenderPipeline({
        label: "atlas.pipeline",
        layout,
        vertex: { module: this.atlasModule, entryPoint: "vs_main" },
        fragment: { module: this.atlasModule, entryPoint: "fs_main", targets: [{ format: this.gpu.format }] },
        primitive: { topology: "triangle-list" },
      });
      const uniformBindGroup = device.createBindGroup({
        label: "atlas.uniform.bg",
        layout: this.atlasUniformBGL,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      });
      const brickBindGroup = device.createBindGroup({
        label: "atlas.brick.bg",
        layout: this.atlasBrickBGL,
        entries: [
          { binding: 0, resource: { buffer: this.brickParamsBuffer! } },
          { binding: 1, resource: { buffer: this.brickMapBuffer! } },
          { binding: 2, resource: this.atlasTexture.createView() },
          { binding: 3, resource: this.atlasSampler },
        ],
      });
      this.atlas = { pipeline, uniformBindGroup, brickBindGroup };
    } else {
      this.atlas.brickBindGroup = device.createBindGroup({
        label: "atlas.brick.bg",
        layout: this.atlasBrickBGL,
        entries: [
          { binding: 0, resource: { buffer: this.brickParamsBuffer! } },
          { binding: 1, resource: { buffer: this.brickMapBuffer! } },
          { binding: 2, resource: this.atlasTexture.createView() },
          { binding: 3, resource: this.atlasSampler! },
        ],
      });
    }
  }

  private writeBrickParams(): void {
    if (!this.brickAtlas || !this.brickParamsBuffer) return;
    const a = this.brickAtlas;
    const buf = new ArrayBuffer(BRICK_PARAMS_BYTES);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    // worldOrigin.xyz, w = BRICK_WORLD
    f[0] = a.world.origin[0];
    f[1] = a.world.origin[1];
    f[2] = a.world.origin[2];
    f[3] = 1.0; // BRICK_WORLD
    // worldBricks.xyz, w = flag (unused)
    u[4] = a.world.size[0];
    u[5] = a.world.size[1];
    u[6] = a.world.size[2];
    u[7] = 1;
    // atlasSlots.xyz, w = BRICK_SAMPLES
    u[8] = a.config.atlasSlots[0];
    u[9] = a.config.atlasSlots[1];
    u[10] = a.config.atlasSlots[2];
    u[11] = BRICK_SAMPLES;
    // atlasTexels.xyz, w = sampleSpacing
    f[12] = a.atlasSamples[0];
    f[13] = a.atlasSamples[1];
    f[14] = a.atlasSamples[2];
    f[15] = SAMPLE_SPACING;
    this.gpu.device.queue.writeBuffer(this.brickParamsBuffer, 0, buf);
  }

  setMode(mode: RenderMode): void {
    if (mode === "atlas" && !this.atlas) {
      if (!this.brickAtlas) this.bakeAtlas(this.sceneRecords);
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
    if (this.mode === "atlas" && this.atlas) {
      pass.setPipeline(this.atlas.pipeline);
      pass.setBindGroup(0, this.atlas.uniformBindGroup);
      pass.setBindGroup(1, this.atlas.brickBindGroup);
    } else {
      pass.setPipeline(this.analytic.pipeline);
      pass.setBindGroup(0, this.analytic.bindGroup);
    }
    pass.draw(3, 1, 0, 0);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  stats(): EngineStats {
    return {
      sceneRecords: this.sceneRecordCount,
      debugMode: this.debugMode === 0 ? "off" : this.debugMode === 1 ? "steps" : "normals",
      resolution: [this.gpu.canvas.width, this.gpu.canvas.height],
      mode: this.mode,
      atlasAllocated: this.brickAtlas?.stats.allocated ?? 0,
      atlasCapacity: this.brickAtlas?.stats.atlasCapacity ?? 0,
    };
  }
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  const gpu = await requestGPU(canvas);
  return new Engine(gpu);
}
