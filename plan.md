# WebGPU Dynamic SDF Renderer — Build Spec

A working specification for Claude Code to incrementally implement a **dynamic signed-distance-field (SDF) renderer** in the browser using WebGPU. The design mirrors the architecture of a native dynamic-SDF game engine (brick-atlas caching, geometry clipmaps, real-time deformation) and adapts it to browser constraints.

Work through the phases in order. Each phase has a deliverable, concrete files to create, and acceptance criteria. Do not skip ahead — later phases depend on the data structures established earlier.

-----

## 0. Goals and non-goals

### Goals

- Render a **dynamic SDF world** in real time in a WebGPU-capable browser.
- Allow **high-fidelity, in-game modification** of geometry: additive, subtractive, smooth, and sharp edits. Boolean-style CSG edits are a first-class feature, not an afterthought.
- Support **non-destructive edits** (e.g. a moving hole, a tunnel that closes behind the camera).
- Scale to **large worlds** without falling back to triangle meshes.
- Maintain interactive frame rates (≥ 60 fps at 1080p on a mid-range discrete GPU) after Phase 4 optimizations are in place.

### Non-goals (initially)

- Triangle-mesh rendering. Geometry is SDF-only.
- Photorealism. Shading is functional (normal-from-gradient + simple lighting) until Phase 6.
- Networking / multiplayer.
- Browser physics parity with Jolt. See Phase 7 for the web substitute.

-----

## 1. Tech stack and constraints

- **Language:** TypeScript (strict mode).
- **Shaders:** WGSL. Prefer compute shaders for SDF evaluation, brick updates, and clipmap streaming. Use a render pass with a full-screen triangle for the final ray-march.
- **Build:** Vite. No framework for the demo harness — a single canvas and a minimal debug HUD.
- **WebGPU feature flags to request where available:** `timestamp-query`, `float32-filterable`, `shader-f16` (optional, behind a flag). Fail gracefully on Safari / older Chromium.
- **Memory ceiling:** Design for ~1 GB of total GPU memory budget. Browser tabs get killed well before native engines do, so sparse structures are not optional.
- **No `eval`, no shader string concatenation from user input.** All WGSL is authored as `.wgsl` files imported as strings.

-----

## 2. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│  Edit Stream  ──►  SDF Evaluator (compute)  ──►  Brick Atlas    │
│  (CSG ops)                                        (sparse 3D    │
│                                                    texture)     │
│                                                        │        │
│  Brick Map (sparse grid of atlas indices) ◄────────────┘        │
│        │                                                         │
│        ▼                                                         │
│  Geometry Clipmap (nested LODs around the camera)               │
│        │                                                         │
│        ▼                                                         │
│  Ray-March Pass (fragment)  ──►  Shading  ──►  Present           │
└─────────────────────────────────────────────────────────────────┘
```

Two data structures carry the design:

1. **Brick map + brick atlas.** The world is partitioned into fixed-size bricks (e.g. 8³ distance samples). Only bricks that actually contain a surface are allocated. The brick map is a sparse 3D index that points into a brick atlas, a large 3D texture that packs the allocated bricks contiguously. This is the cache. The ray-march reads interpolated samples from it rather than evaluating SDF math per-step.
1. **Geometry clipmap.** Nested regular grids centered on the camera, each grid twice the size of the previous at half the resolution. Bricks are streamed in/out of the atlas as the camera moves. This is how the world scales to large distances without allocating everything at once.

The renderer never re-derives geometry on demand; it always reads the cache. The cache is kept coherent by a compute pipeline that re-evaluates dirty bricks whenever an edit lands.

-----

## 3. Repository layout

Create this structure on Phase 1:

```
/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main.ts                 # entry, device setup, loop
│   ├── engine/
│   │   ├── Engine.ts           # owns device, queue, resources, frame graph
│   │   ├── Camera.ts
│   │   ├── Clock.ts
│   │   └── Input.ts
│   ├── sdf/
│   │   ├── BrickMap.ts         # sparse index, allocation / free list
│   │   ├── BrickAtlas.ts       # 3D texture + CPU-side allocator
│   │   ├── Clipmap.ts          # LOD rings, streaming policy
│   │   ├── EditQueue.ts        # CSG ops, dirty-brick tracking
│   │   └── Primitives.ts       # sphere, box, capsule, plane, etc.
│   ├── render/
│   │   ├── RayMarcher.ts       # pipeline wiring
│   │   ├── Shading.ts
│   │   └── Debug.ts            # brick visualization, step-count heatmap
│   ├── shaders/
│   │   ├── common/
│   │   │   ├── sdf_ops.wgsl    # union / intersect / subtract / smooth
│   │   │   ├── brick.wgsl      # atlas sampling, brick lookup
│   │   │   └── clipmap.wgsl    # lod selection
│   │   ├── evaluate_brick.wgsl # compute: fill a brick from analytic SDF
│   │   ├── apply_edit.wgsl     # compute: CSG an edit into dirty bricks
│   │   └── raymarch.wgsl       # fragment: sphere-trace the atlas
│   └── util/
│       ├── gpu.ts
│       └── math.ts
└── README.md
```

-----

## 4. Implementation phases

### Phase 1 — Bootstrap and a single analytic SDF

**Deliverable:** A WebGPU canvas that ray-marches a single analytic sphere SDF, evaluated per-pixel in the fragment shader. No caching yet. This exists to prove the pipeline and give a baseline for the optimization phases.

**Tasks:**

- Initialize adapter, device, canvas, swapchain. Handle context-loss.
- Implement a `Camera` with free-fly controls.
- Write `raymarch.wgsl` with a classic sphere-tracing loop (fixed max steps, epsilon termination).
- Compute normals from the SDF gradient via central differences.
- Apply a placeholder Lambert + sky shade.

**Acceptance:**

- Sphere renders at 1080p, sharp silhouette, no seams at the horizon.
- Step count is exposed as a debug overlay.

### Phase 2 — Analytic scenes and CSG

**Deliverable:** A small library of primitives and CSG operators evaluated analytically in WGSL. Still per-pixel, still no cache.

**Tasks:**

- Implement `sphere`, `box`, `roundBox`, `capsule`, `plane`, `torus` in `sdf_ops.wgsl`.
- Implement `opUnion`, `opSubtract`, `opIntersect`, and their smooth variants (`opSmoothUnion` via polynomial min, etc.). Reference: Inigo Quilez’s SDF articles.
- Build a tiny scene graph (TypeScript) that serializes to a flat op-code buffer the shader walks. Keep the evaluator a linear interpreter — avoid recursion in WGSL.
- Add a debug heatmap view that colors pixels by step count.

**Acceptance:**

- A scene with at least 20 primitives combined via smooth-union and subtraction renders correctly.
- Smooth operators produce visibly continuous normals.

### Phase 3 — Brick atlas and brick map

**Deliverable:** The analytic SDF is baked once into a sparse cache. The fragment shader reads interpolated distances from the atlas instead of re-evaluating the op tree.

**Data structures:**

- **Brick:** an `8 × 8 × 8` block of `f16` (fallback `f32`) signed distances. 8 is a reasonable default; make it a const so it can be tuned.
- **Brick atlas:** a single 3D texture, e.g. `256 × 256 × 256` samples, divided into `32 × 32 × 32 = 32768` brick slots.
- **Brick map:** a sparse 3D index covering world space at brick resolution. Entry is either a sentinel `EMPTY`, a sentinel `SOLID_INSIDE`, or an atlas slot index. Implement as a hash grid keyed on `(ix, iy, iz)` of the brick coordinate.
- **Free list:** a stack of available atlas slots.

**Tasks:**

- Write `evaluate_brick.wgsl`: given a brick coordinate, evaluate the op-tree at each of the 8³ samples and write into the atlas slot.
- Brick allocation policy: allocate on demand only when the analytic SDF over the brick’s bounding cube crosses zero. Use a coarse interval or Lipschitz bound to reject empty bricks cheaply. Reject bricks that are fully inside the solid as `SOLID_INSIDE`.
- Update `raymarch.wgsl` to look up the brick map, fetch the atlas slot, and read trilinearly interpolated distances. Outside allocated bricks, fall back to a conservative large step (the brick size).

**Acceptance:**

- The same Phase 2 scene renders at ≥ 3× the frame rate of Phase 2, with no visible loss of silhouette quality.
- The brick count for a 10 m³ scene fits in well under half the atlas.
- Reference: NVIDIA, *Ray Tracing of Signed Distance Function Grids* — their sampling and empty-space skipping scheme is a close match.

### Phase 4 — Geometry clipmap

**Deliverable:** The world extends beyond what a single dense brick map can cover. Clipmap rings centered on the camera provide LOD and stream bricks in and out as the camera moves.

**Tasks:**

- Define N clipmap levels (default 6). Level `L` covers `2^L` times the volume of level 0 at half the brick resolution per axis.
- For each level, keep a toroidal brick-map ring buffer. When the camera crosses a brick boundary, invalidate the strip of bricks that just fell out and enqueue the new strip for evaluation.
- Select the right level per ray sample based on distance from the camera. Blend across level boundaries to hide seams (either by overlapping the outer edge of level `L` with the inner edge of level `L+1` and cross-fading, or by snapping based on a dithered threshold).
- Budget brick re-evaluations per frame so a fast camera cannot stall the compute queue. A small ring queue with a per-frame cap (e.g. 512 bricks) works.

**Acceptance:**

- A flight across a 10 km synthetic terrain sustains ≥ 60 fps.
- No visible pop-in from streaming. Level transitions are not obvious without the debug overlay.
- Reference: Losasso & Hoppe, *Geometry Clipmaps*.

### Phase 5 — Real-time edits and dirty-brick propagation

**Deliverable:** The player can deform the world with a CSG brush in real time. Edits propagate into the atlas within a frame or two and are visible next render.

**Tasks:**

- `EditQueue`: append-only list of `{ op, primitive, params, aabb }`. The `aabb` is the edit’s world-space bounding box, expanded by the smooth-op radius.
- On each edit submission:
1. Compute the set of bricks overlapping the edit aabb across every clipmap level.
1. Mark those bricks dirty.
1. Enqueue a compute dispatch that runs `apply_edit.wgsl` over exactly the dirty bricks: read current atlas values, apply the op, write back.
- Persist the edit list and replay it on brick (re)allocation — this is what makes the edits *real* geometry rather than just a post-process, and it is what allows edits to survive streaming.
- Keep the edit list bounded: once an edit has been baked into every clipmap level’s relevant bricks and those bricks are unlikely to be freed, the edit can be “retired” into a lower-resolution cached delta. This is an optimization; implement it only once the unbounded list becomes a problem.

**Acceptance:**

- Left-click places an additive sphere; right-click subtracts. Latency is imperceptible.
- Carving a tunnel and flying away, then returning, shows the tunnel intact.
- Re-allocating a brick (e.g. by flying out and back in) produces the same geometry it had before.

### Phase 6 — Shading and visual quality

Optional but useful once the engine is correct.

- Soft shadows from sphere-tracing the light direction. Cheap and SDF-native.
- Ambient occlusion from short SDF steps along the normal.
- Triplanar texturing driven by the normal — works naturally on SDF surfaces where UVs do not exist.
- Screen-space denoise or TAA to hide the stepped nature of AO / soft shadows.

### Phase 7 — Physics (web substitute for Jolt)

Jolt does not run natively in the browser. Two viable substitutes:

- **Rapier (Rust → WASM).** Closest in feature set to Jolt. Use for rigid bodies and character controllers.
- **Custom SDF collision.** Because the world *is* an SDF, character-vs-world collision is trivial: sample the atlas along the sweep, push out along the gradient. Dynamic rigid bodies can use Rapier for body-body and a custom SDF query for body-world.

Recommended split: Rapier for bodies, direct atlas sampling for body-vs-world. Do not attempt to extract a triangle mesh from the SDF to feed Rapier — it defeats the point.

-----

## 5. Performance targets

Track these in the HUD from Phase 3 onward. A regression in any of them should block merging a change.

|Metric                            |Target            |
|----------------------------------|------------------|
|Frame time @ 1080p, mid-range dGPU|≤ 16.6 ms         |
|Ray-march steps / pixel (median)  |≤ 32              |
|Atlas occupancy                   |≤ 70% steady state|
|Dirty-brick re-eval budget / frame|≤ 2 ms            |
|Edit-to-visible latency           |≤ 2 frames        |

-----

## 6. Testing

- **Unit tests (Vitest)** for `BrickMap`, `BrickAtlas` allocator, clipmap ring math, and analytic SDF ops (verify against reference JS implementations of Quilez’s primitives).
- **Golden-image tests** for the renderer: seeded scene, fixed camera, compare the rendered frame against a committed PNG within an L2 tolerance. Run headless with `webgpu` in Node via `@webgpu/*` polyfills, or in a headed Playwright harness.
- **Fuzz the edit queue**: apply random CSG ops, free and re-allocate bricks across clipmap transitions, assert that a brick’s final contents match a ground-truth analytic evaluation at its sample points.

-----

## 7. References

- Inigo Quilez — SDF primitives, smooth operators, normal estimation. https://iquilezles.org/articles/
- Wright et al., NVIDIA — *Ray Tracing of Signed Distance Function Grids*. Brick-atlas sampling and empty-space skipping.
- Losasso & Hoppe — *Geometry Clipmaps: Terrain Rendering Using Nested Regular Grids*.
- Media Molecule — the *Dreams* tech talks for the voxel-plus-SDF rendering philosophy that inspires the caching approach here.
- WebGPU spec and WGSL spec — https://www.w3.org/TR/webgpu/ and https://www.w3.org/TR/WGSL/

-----

## 8. Working notes for Claude Code

- Do not collapse phases. Land Phase 1 and Phase 2 before starting the brick atlas — a working analytic baseline makes Phase 3 debuggable.
- When a WGSL change and a TypeScript change are coupled (e.g. a bind-group layout), land them in a single commit with the layout defined in one place and imported by both sides.
- Prefer storage textures over storage buffers for the atlas — trilinear filtering is what makes the cache fast.
- Every compute dispatch that writes the atlas needs a barrier before the next render pass reads it. Use `queue.submit` boundaries conservatively until the frame graph is in place.
- Assume the target device does not support `float32-filterable`. The atlas should default to a filterable format (`r16float` is fine) and fall back to manual trilinear in WGSL only if a device surfaces without filtering support.
