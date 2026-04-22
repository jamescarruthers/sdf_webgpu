# WebGPU Dynamic SDF Renderer

A browser-side dynamic SDF renderer built from the phased spec in `plan.md`.

## Status

- **Phase 1 — Bootstrap and analytic sphere**: complete.
- **Phase 2 — Analytic scenes and CSG**: complete. Primitive library (sphere,
  box, round-box, capsule, plane, torus) with hard and smooth CSG operators,
  walked by a WGSL stack interpreter.
- **Phase 3 — Brick atlas cache**: complete (MVP). Superseded at runtime by
  the Phase 4 clipmap; the single-level baker remains in `BrickAtlas.ts` as a
  unit-testable reference implementation.
- **Phase 4 — Geometry clipmap**: complete (MVP). N concentric toroidal rings
  of bricks centred on the camera, each level 2× coarser than the one inside
  it, sharing a single atlas texture. A per-frame streaming budget bakes new
  bricks as the camera moves; LOD selection happens per ray sample. **This is
  the default render path at boot.**

Phases 5+ (real-time edits, higher-end shading, physics) are not yet
implemented.

## Controls

| Input          | Action                                     |
| -------------- | ------------------------------------------ |
| `WASD`         | Move horizontally                          |
| `Space / Ctrl` | Up / down                                  |
| `Shift`        | Sprint                                     |
| Left-click     | Capture pointer, then drag to look         |
| `1`            | Toggle step-count heatmap                  |
| `2`            | Toggle normal visualization                |
| `3`            | Clear debug overlays                       |
| `M`            | Toggle clipmap ↔ analytic render path      |

## Scenes

The URL parameter `?scene=<name>` selects the scene:

- `sphere` — the Phase 1 analytic baseline (single unit sphere).
- `demo` — the Phase 2 CSG showcase (~30 primitives in ~10 m).
- `large` *(default)* — a 500 m lattice of landmarks for stressing the
  clipmap streamer.

## Run

```
npm install
npm run dev       # Vite dev server on :5173
npm run build     # type-check + production bundle
npm run test      # Vitest unit tests
```

Requires a WebGPU-capable browser (Chrome 113+, Edge, recent Safari Technology
Preview with WebGPU enabled).

## Layout

```
src/
  engine/     Engine, Camera, Clock, Input — frame loop & GPU lifecycle
  sdf/        Primitives, SceneBuilder, SdfEval, BrickAtlas (legacy), Clipmap
  shaders/    WGSL sources imported as raw strings and concatenated by Engine
  util/       gpu.ts (adapter/device/context), math.ts (Vec3, Mat4)
```

## Design notes

- The world is partitioned into 1 m bricks at the innermost clipmap level;
  each allocated brick stores an 8³ block of distance samples. Adjacent bricks
  share a boundary sample so hardware trilinear filtering stays continuous
  across seams within a level.
- Each clipmap level is a fixed-size toroidal ring — moving the camera one
  brick invalidates only the strip that just fell out and enqueues the strip
  that just came in. The free list recycles atlas slots as bricks evict.
- LOD transitions happen at a 2-brick inset from each level's ring boundary,
  not at the ring edge itself, so hard snapping doesn't hit the camera's
  immediate surroundings.
- The JS SDF evaluator in `src/sdf/SdfEval.ts` mirrors the WGSL interpreter in
  `src/shaders/common/scene.wgsl` exactly — the brick baker relies on this and
  a unit test cross-checks their output at sample points.
- The analytic and clipmap render paths are separate render pipelines behind a
  runtime flag; only the bind group layout each needs is declared.
