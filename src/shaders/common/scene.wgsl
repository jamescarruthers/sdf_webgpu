// Scene op-code interpreter. A scene is a linear program in Reverse Polish
// Notation: primitive opcodes push a distance onto a small stack, CSG opcodes
// pop operands and push a result. This matches the shape of a depth-first
// evaluation of an SDF tree without requiring WGSL recursion.
//
// Record layout (8 f32 / 2 vec4<f32>):
//   [0] = opcode (cast to u32)
//   [1..7] = up to 7 scalar parameters whose meaning is opcode-specific

const OP_END: u32 = 0u;
const OP_SPHERE: u32 = 1u;
const OP_BOX: u32 = 2u;
const OP_ROUNDBOX: u32 = 3u;
const OP_CAPSULE: u32 = 4u;
const OP_PLANE_Y: u32 = 5u;
const OP_TORUS: u32 = 6u;

const OP_UNION: u32 = 16u;
const OP_SUBTRACT: u32 = 17u;
const OP_INTERSECT: u32 = 18u;
const OP_SMOOTH_UNION: u32 = 19u;
const OP_SMOOTH_SUBTRACT: u32 = 20u;
const OP_SMOOTH_INTERSECT: u32 = 21u;

const MAX_STACK: u32 = 32u;

struct SceneRecord {
  a: vec4<f32>,
  b: vec4<f32>,
};

struct SceneHeader {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

// The scene binding. Records are packed contiguously.
@group(0) @binding(1) var<storage, read> scene_header: SceneHeader;
@group(0) @binding(2) var<storage, read> scene_records: array<SceneRecord>;

fn evalScene(p: vec3<f32>) -> f32 {
  var stack: array<f32, 32>;
  var sp: u32 = 0u;
  let n = scene_header.count;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let rec = scene_records[i];
    let op = u32(rec.a.x);

    if (op == OP_SPHERE) {
      let c = vec3<f32>(rec.a.y, rec.a.z, rec.a.w);
      let r = rec.b.x;
      if (sp < MAX_STACK) { stack[sp] = sdSphere(p - c, r); sp = sp + 1u; }
    } else if (op == OP_BOX) {
      let c = vec3<f32>(rec.a.y, rec.a.z, rec.a.w);
      let e = vec3<f32>(rec.b.x, rec.b.y, rec.b.z);
      if (sp < MAX_STACK) { stack[sp] = sdBox(p - c, e); sp = sp + 1u; }
    } else if (op == OP_ROUNDBOX) {
      let c = vec3<f32>(rec.a.y, rec.a.z, rec.a.w);
      let e = vec3<f32>(rec.b.x, rec.b.y, rec.b.z);
      let rr = rec.b.w;
      if (sp < MAX_STACK) { stack[sp] = sdRoundBox(p - c, e, rr); sp = sp + 1u; }
    } else if (op == OP_CAPSULE) {
      let a0 = vec3<f32>(rec.a.y, rec.a.z, rec.a.w);
      let b0 = vec3<f32>(rec.b.x, rec.b.y, rec.b.z);
      let rr = rec.b.w;
      if (sp < MAX_STACK) { stack[sp] = sdCapsule(p, a0, b0, rr); sp = sp + 1u; }
    } else if (op == OP_PLANE_Y) {
      let h = rec.a.y;
      if (sp < MAX_STACK) { stack[sp] = sdPlaneY(p, h); sp = sp + 1u; }
    } else if (op == OP_TORUS) {
      let c = vec3<f32>(rec.a.y, rec.a.z, rec.a.w);
      let R = rec.b.x;
      let rr = rec.b.y;
      if (sp < MAX_STACK) { stack[sp] = sdTorus(p - c, R, rr); sp = sp + 1u; }
    } else if (op == OP_UNION) {
      if (sp >= 2u) { let b1 = stack[sp - 1u]; let a1 = stack[sp - 2u]; stack[sp - 2u] = opUnion(a1, b1); sp = sp - 1u; }
    } else if (op == OP_SUBTRACT) {
      if (sp >= 2u) { let b1 = stack[sp - 1u]; let a1 = stack[sp - 2u]; stack[sp - 2u] = opSubtract(a1, b1); sp = sp - 1u; }
    } else if (op == OP_INTERSECT) {
      if (sp >= 2u) { let b1 = stack[sp - 1u]; let a1 = stack[sp - 2u]; stack[sp - 2u] = opIntersect(a1, b1); sp = sp - 1u; }
    } else if (op == OP_SMOOTH_UNION) {
      if (sp >= 2u) { let k = rec.a.y; let b1 = stack[sp - 1u]; let a1 = stack[sp - 2u]; stack[sp - 2u] = opSmoothUnion(a1, b1, k); sp = sp - 1u; }
    } else if (op == OP_SMOOTH_SUBTRACT) {
      if (sp >= 2u) { let k = rec.a.y; let b1 = stack[sp - 1u]; let a1 = stack[sp - 2u]; stack[sp - 2u] = opSmoothSubtract(a1, b1, k); sp = sp - 1u; }
    } else if (op == OP_SMOOTH_INTERSECT) {
      if (sp >= 2u) { let k = rec.a.y; let b1 = stack[sp - 1u]; let a1 = stack[sp - 2u]; stack[sp - 2u] = opSmoothIntersect(a1, b1, k); sp = sp - 1u; }
    }
  }
  if (sp == 0u) { return 1e20; }
  return stack[0];
}

fn sceneNormal(p: vec3<f32>) -> vec3<f32> {
  let h = 0.0005;
  let dx = evalScene(p + vec3<f32>(h, 0.0, 0.0)) - evalScene(p - vec3<f32>(h, 0.0, 0.0));
  let dy = evalScene(p + vec3<f32>(0.0, h, 0.0)) - evalScene(p - vec3<f32>(0.0, h, 0.0));
  let dz = evalScene(p + vec3<f32>(0.0, 0.0, h)) - evalScene(p - vec3<f32>(0.0, 0.0, h));
  return normalize(vec3<f32>(dx, dy, dz));
}
