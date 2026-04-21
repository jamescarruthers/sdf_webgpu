// Helpers shared across fragment pipelines: fullscreen triangle, sky, heatmap.

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var xy = vec2<f32>(-1.0, -1.0);
  if (vid == 1u) { xy = vec2<f32>(3.0, -1.0); }
  if (vid == 2u) { xy = vec2<f32>(-1.0, 3.0); }
  var o: VSOut;
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = xy * 0.5 + vec2<f32>(0.5);
  return o;
}

fn skyColor(d: vec3<f32>) -> vec3<f32> {
  let t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  let horizon = vec3<f32>(0.55, 0.65, 0.78);
  let zenith = vec3<f32>(0.10, 0.18, 0.32);
  return mix(horizon, zenith, t);
}

fn heatmap(t: f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.267, 0.005, 0.329);
  let c1 = vec3<f32>(0.129, 0.447, 0.560);
  let c2 = vec3<f32>(0.369, 0.788, 0.382);
  let c3 = vec3<f32>(0.988, 0.906, 0.145);
  let x = clamp(t, 0.0, 1.0);
  if (x < 0.333) { return mix(c0, c1, x / 0.333); }
  if (x < 0.666) { return mix(c1, c2, (x - 0.333) / 0.333); }
  return mix(c2, c3, (x - 0.666) / 0.334);
}

fn primaryRay(in: VSOut) -> vec3<f32> {
  let aspect = U.camUp.w;
  let tanHalf = U.camRight.w;
  let ndc = in.uv * 2.0 - vec2<f32>(1.0);
  let sx = ndc.x * tanHalf * aspect;
  let sy = ndc.y * tanHalf;
  return normalize(U.camForward.xyz + U.camRight.xyz * sx + U.camUp.xyz * sy);
}
