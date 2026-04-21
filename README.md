# WebGPU Dynamic SDF Renderer

A browser-side dynamic SDF renderer built from the phased spec in `plan.md`.

## Status

- **Phase 1 — Bootstrap and analytic sphere**: complete. Full-screen ray-march
  in a fragment shader, central-difference normals, Lambert + sky shade, step
  count exposed to a debug overlay.
- **Phase 2 — Analytic scenes and CSG**: complete. Primitive library (sphere,
  box, round-box, capsule, plane, torus) with hard and smooth CSG operators.
  Scenes are built from an RPN op-code buffer that a WGSL interpreter walks at
  render time. The default `demoScene` puts 30+ primitives on screen.
- **Phase 3 — Brick atlas cache**: complete (MVP). A dense world-brick grid is
  baked into a 3D `r16float` atlas at load; the ray-march reads trilinearly
  interpolated samples rather than re-evaluating the analytic tree per-step.
  Toggle with `M`.

Phases 4+ (geometry clipmap, real-time edits, higher-end shading, physics) are
not yet implemented.

## Controls

| Input         | Action                                     |
| ------------- | ------------------------------------------ |
| `WASD`        | Move horizontally                          |
| `Space / Ctrl`| Up / down                                  |
| `Shift`       | Sprint                                     |
| Left-click    | Capture pointer, then drag to look         |
| `1`           | Toggle step-count heatmap                  |
| `2`           | Toggle normal visualization                |
| `3`           | Clear debug overlays                       |
| `M`           | Toggle analytic ↔ brick-atlas render path  |

## Run

```
npm install
npm run dev       # Vite dev server on :5173
npm run build     # type-check + production bundle
npm run test      # Vitest unit tests
```

Requires a WebGPU-capable browser (Chrome 113+, Edge, Chrome Canary on macOS,
Safari Technology Preview with WebGPU enabled).

## Layout

```
src/
  engine/     Engine, Camera, Clock, Input — frame loop & GPU lifecycle
  sdf/        Primitives, SceneBuilder, SdfEval (JS mirror of WGSL), BrickAtlas
  shaders/    WGSL sources imported as raw strings and concatenated by Engine
  util/       gpu.ts (adapter/device/context), math.ts (Vec3, Mat4)
```

## Design notes

- The world is a regular grid of 1 m bricks; each allocated brick stores an 8³
  block of distance samples so adjacent bricks share a boundary sample and
  hardware trilinear filtering stays continuous across seams.
- The JS SDF evaluator in `src/sdf/SdfEval.ts` mirrors the WGSL interpreter in
  `src/shaders/common/scene.wgsl` exactly — the brick baker relies on this and
  a unit test cross-checks their output at sample points.
- The analytic and atlas pipelines are separate render pipelines behind a
  runtime flag; only the bind group layout they need gets declared. This lets
  Phase 3 ship without regressing the Phase 1/2 path.
