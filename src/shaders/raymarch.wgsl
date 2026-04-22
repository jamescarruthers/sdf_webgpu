// Phase 1/2 fragment-shader ray-march — per-pixel analytic SDF evaluation.
// Expects (concatenated in this order): uniforms.wgsl, sdf_ops.wgsl,
// scene.wgsl, shared.wgsl, then this file.

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let rd = primaryRay(in);
  let ro = U.camPos.xyz;

  let maxSteps = u32(U.params.x);
  let maxDist = U.params.y;
  let eps = U.params.z;

  var t = 0.0;
  var hit = false;
  var steps: u32 = 0u;
  var p = ro;
  for (var i: u32 = 0u; i < maxSteps; i = i + 1u) {
    steps = i + 1u;
    p = ro + rd * t;
    let d = evalScene(p);
    if (d < eps) { hit = true; break; }
    t = t + max(d, eps * 0.5);
    if (t > maxDist) { break; }
  }

  let debugMode = U.camForward.w;
  if (debugMode > 0.5 && debugMode < 1.5) {
    return vec4<f32>(heatmap(f32(steps) / f32(maxSteps)), 1.0);
  }

  if (!hit) {
    return vec4<f32>(skyColor(rd), 1.0);
  }

  let n = sceneNormal(p);
  if (debugMode > 1.5 && debugMode < 2.5) {
    return vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0);
  }

  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let ndl = max(dot(n, lightDir), 0.0);
  let base = vec3<f32>(0.80, 0.82, 0.86);
  let ambient = skyColor(n) * 0.35;
  let lit = base * (ndl * vec3<f32>(1.0, 0.98, 0.92) + ambient);

  let fog = 1.0 - exp(-t * 0.004);
  let color = mix(lit, skyColor(rd), fog);
  return vec4<f32>(color, 1.0);
}
