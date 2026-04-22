// Phase 4 ray-march over the geometry clipmap. Expects (concatenated in
// order): uniforms.wgsl, clipmap.wgsl, shared.wgsl, then this file.

fn clipmapNormal(p: vec3<f32>, level: u32) -> vec3<f32> {
  // Central differences against the cached field, scaled to the sampled
  // level's spacing so the gradient tracks the trilinear interpolant.
  let params = clipmapLevels[level];
  let h = max(params.sampleSpacing.x * 0.5, 1e-4);
  let dx = clipmapDistance(p + vec3<f32>(h, 0.0, 0.0)) - clipmapDistance(p - vec3<f32>(h, 0.0, 0.0));
  let dy = clipmapDistance(p + vec3<f32>(0.0, h, 0.0)) - clipmapDistance(p - vec3<f32>(0.0, h, 0.0));
  let dz = clipmapDistance(p + vec3<f32>(0.0, 0.0, h)) - clipmapDistance(p - vec3<f32>(0.0, 0.0, h));
  let g = vec3<f32>(dx, dy, dz);
  let l = max(length(g), 1e-6);
  return g / l;
}

fn levelTint(L: u32) -> vec3<f32> {
  let palette = array<vec3<f32>, 6>(
    vec3<f32>(0.9, 0.95, 1.0),
    vec3<f32>(0.75, 1.0, 0.85),
    vec3<f32>(1.0, 0.9, 0.7),
    vec3<f32>(1.0, 0.75, 0.75),
    vec3<f32>(0.85, 0.75, 1.0),
    vec3<f32>(0.65, 0.85, 1.0),
  );
  return palette[L % 6u];
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let rd = primaryRay(in);
  let ro = U.camPos.xyz;

  let maxSteps = u32(U.params.x);
  let maxDist = U.params.y;
  let eps = U.params.z;

  var t = 0.0;
  var hit = false;
  var hitLevel: u32 = 0u;
  var steps: u32 = 0u;
  var p = ro;
  for (var i: u32 = 0u; i < maxSteps; i = i + 1u) {
    steps = i + 1u;
    p = ro + rd * t;
    let s = sampleClipmap(p);
    // Outside the coarsest ring = past the clipmap's coverage, i.e. sky.
    if (s.kind == 0u) { break; }
    if (s.kind == 2u) { hit = true; hitLevel = s.level; break; }
    if (s.kind == 3u && s.distance < eps) { hit = true; hitLevel = s.level; break; }
    let step = max(s.distance, eps * 0.5);
    t = t + step;
    if (t > maxDist) { break; }
  }

  let debugMode = U.camForward.w;
  if (debugMode > 0.5 && debugMode < 1.5) {
    return vec4<f32>(heatmap(f32(steps) / f32(maxSteps)), 1.0);
  }

  if (!hit) {
    return vec4<f32>(skyColor(rd), 1.0);
  }

  let n = clipmapNormal(p, hitLevel);
  if (debugMode > 1.5 && debugMode < 2.5) {
    return vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0);
  }

  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let ndl = max(dot(n, lightDir), 0.0);
  let tint = levelTint(hitLevel);
  let base = vec3<f32>(0.80, 0.82, 0.86) * tint;
  let ambient = skyColor(n) * 0.35;
  let lit = base * (ndl * vec3<f32>(1.0, 0.98, 0.92) + ambient);

  let fog = 1.0 - exp(-t * 0.0025);
  let color = mix(lit, skyColor(rd), fog);
  return vec4<f32>(color, 1.0);
}
