// Signed distance primitives and CSG operators.
// Reference: https://iquilezles.org/articles/distfunctions/

fn sdSphere(p: vec3<f32>, r: f32) -> f32 {
  return length(p) - r;
}

fn sdBox(p: vec3<f32>, b: vec3<f32>) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdRoundBox(p: vec3<f32>, b: vec3<f32>, r: f32) -> f32 {
  return sdBox(p, b - vec3<f32>(r)) - r;
}

fn sdCapsule(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

fn sdPlaneY(p: vec3<f32>, h: f32) -> f32 {
  return p.y - h;
}

fn sdTorus(p: vec3<f32>, R: f32, r: f32) -> f32 {
  let q = vec2<f32>(length(p.xz) - R, p.y);
  return length(q) - r;
}

// Hard CSG
fn opUnion(a: f32, b: f32) -> f32 { return min(a, b); }
fn opSubtract(a: f32, b: f32) -> f32 { return max(a, -b); }
fn opIntersect(a: f32, b: f32) -> f32 { return max(a, b); }

// Smooth CSG via polynomial blend. k > 0 gives the blend radius in distance units.
fn opSmoothUnion(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn opSmoothSubtract(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 - 0.5 * (b + a) / max(k, 1e-6), 0.0, 1.0);
  return mix(a, -b, h) + k * h * (1.0 - h);
}

fn opSmoothIntersect(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 - 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
