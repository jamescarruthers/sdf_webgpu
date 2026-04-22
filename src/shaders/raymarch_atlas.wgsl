// Phase 3 ray-march reading distances from the brick atlas. Expects
// (concatenated in order): uniforms.wgsl, brick.wgsl, shared.wgsl, then this
// file.

fn atlasNormal(p: vec3<f32>) -> vec3<f32> {
  // Central differences on the cached field. The step size is a small
  // fraction of the sample spacing so the gradient tracks the trilinear
  // interpolant rather than jumping across samples.
  let h = brickParams.atlasTexels.w * 0.5;
  let dx = brickDistance(p + vec3<f32>(h, 0.0, 0.0)) - brickDistance(p - vec3<f32>(h, 0.0, 0.0));
  let dy = brickDistance(p + vec3<f32>(0.0, h, 0.0)) - brickDistance(p - vec3<f32>(0.0, h, 0.0));
  let dz = brickDistance(p + vec3<f32>(0.0, 0.0, h)) - brickDistance(p - vec3<f32>(0.0, 0.0, h));
  let g = vec3<f32>(dx, dy, dz);
  let l = max(length(g), 1e-6);
  return g / l;
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
  var steps: u32 = 0u;
  var p = ro;
  for (var i: u32 = 0u; i < maxSteps; i = i + 1u) {
    steps = i + 1u;
    p = ro + rd * t;
    let s = sampleBrick(p);
    if (s.kind == 2u || s.distance < eps) {
      if (s.kind != 0u && s.kind != 1u) {
        hit = true;
        break;
      }
    }
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

  let n = atlasNormal(p);
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
