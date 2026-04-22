// Geometry clipmap sampling.
//
// A stack of toroidal brick rings, each level twice as coarse as the one
// inside it. The innermost level that contains the sample (minus a 2-brick
// inset) wins — so LOD transitions always happen a couple of bricks short of
// the outer face, which keeps artifacts well away from the camera.
//
// Bind layout (group 1):
//   @binding(0) clipmapParams    — uniform globals
//   @binding(1) clipmapLevels    — storage-read array of LevelParams
//   @binding(2) clipmapBrickMap  — storage-read concatenated u32 brick maps
//   @binding(3) atlasTexture     — texture_3d<f32>  (r16float, linear-filterable)
//   @binding(4) atlasSampler     — linear sampler

struct LevelParams {
  origin: vec4<f32>,      // xyz = world min corner of ring, w = brickWorld
  info: vec4<u32>,        // x,y,z = ringBricks, w = brickMap offset (in u32 words)
  originBrick: vec4<i32>, // xyz = origin brick coord, w unused
  sampleSpacing: vec4<f32>, // x = sampleSpacing for this level
};

struct ClipmapParams {
  levelCount: vec4<u32>,  // x = count, yzw unused
  atlasSlots: vec4<u32>,  // xyz = slots per axis, w = samples per brick
  atlasTexels: vec4<f32>, // xyz = atlas texture dims
};

const CLIP_EMPTY_U: u32 = 0xffffffffu;
const CLIP_SOLID_U: u32 = 0xfffffffeu;
const CLIP_NO_LEVEL: u32 = 0xffffffffu;
const LOD_INSET: f32 = 2.0;

@group(1) @binding(0) var<uniform> clipmapParams: ClipmapParams;
@group(1) @binding(1) var<storage, read> clipmapLevels: array<LevelParams>;
@group(1) @binding(2) var<storage, read> clipmapBrickMap: array<u32>;
@group(1) @binding(3) var atlasTexture: texture_3d<f32>;
@group(1) @binding(4) var atlasSampler: sampler;

fn modPositive(a: i32, b: i32) -> i32 {
  return ((a % b) + b) % b;
}

fn slotOriginFromIdx(slot: u32) -> vec3<u32> {
  let sx = clipmapParams.atlasSlots.x;
  let sy = clipmapParams.atlasSlots.y;
  let ox = slot % sx;
  let oy = (slot / sx) % sy;
  let oz = slot / (sx * sy);
  let n = clipmapParams.atlasSlots.w;
  return vec3<u32>(ox * n, oy * n, oz * n);
}

/// Returns the index of the innermost clipmap level whose "usable" region
/// contains the world point, or CLIP_NO_LEVEL if the point is outside all
/// levels. The outermost level has no inset so sky rays that fall through the
/// coarsest ring get the sentinel.
fn selectLevel(P: vec3<f32>) -> u32 {
  let count = clipmapParams.levelCount.x;
  for (var L: u32 = 0u; L < count; L = L + 1u) {
    let params = clipmapLevels[L];
    let local = (P - params.origin.xyz) / params.origin.w;
    let rb = vec3<f32>(f32(params.info.x), f32(params.info.y), f32(params.info.z));
    var inset = LOD_INSET;
    if (L + 1u == count) { inset = 0.0; }
    if (all(local >= vec3<f32>(inset)) && all(local < rb - vec3<f32>(inset))) {
      return L;
    }
  }
  return CLIP_NO_LEVEL;
}

struct ClipSample {
  distance: f32,
  kind: u32,   // 0 = outside clipmap, 1 = empty, 2 = solid, 3 = surface
  level: u32,  // level that was sampled (valid when kind != 0)
};

fn sampleClipmap(P: vec3<f32>) -> ClipSample {
  var out: ClipSample;
  out.level = 0u;

  let L = selectLevel(P);
  if (L == CLIP_NO_LEVEL) {
    out.distance = 0.0;
    out.kind = 0u;
    return out;
  }
  let params = clipmapLevels[L];
  let bw = params.origin.w;

  let rel = (P - params.origin.xyz) / bw;
  let brickCoord = vec3<i32>(
    i32(floor(rel.x)) + params.originBrick.x,
    i32(floor(rel.y)) + params.originBrick.y,
    i32(floor(rel.z)) + params.originBrick.z,
  );
  let rbU = params.info.xyz;
  let rbI = vec3<i32>(rbU);
  let ring = vec3<u32>(
    u32(modPositive(brickCoord.x, rbI.x)),
    u32(modPositive(brickCoord.y, rbI.y)),
    u32(modPositive(brickCoord.z, rbI.z)),
  );
  let ringLinearIdx = (ring.z * rbU.y + ring.y) * rbU.x + ring.x;
  let entry = clipmapBrickMap[params.info.w + ringLinearIdx];

  out.level = L;
  if (entry == CLIP_EMPTY_U) {
    // Half-brick conservative step in the current level's units.
    out.distance = bw * 0.5;
    out.kind = 1u;
    return out;
  }
  if (entry == CLIP_SOLID_U) {
    out.distance = -bw * 0.25;
    out.kind = 2u;
    return out;
  }

  let n = clipmapParams.atlasSlots.w;
  let origin = slotOriginFromIdx(entry);
  let local = rel - vec3<f32>(floor(rel)); // 0..1 inside the brick
  let fn_ = f32(n - 1u);
  let texel = vec3<f32>(origin) + local * fn_ + vec3<f32>(0.5);
  let uvw = texel / clipmapParams.atlasTexels.xyz;
  out.distance = textureSampleLevel(atlasTexture, atlasSampler, uvw, 0.0).r;
  out.kind = 3u;
  return out;
}

fn clipmapDistance(P: vec3<f32>) -> f32 {
  return sampleClipmap(P).distance;
}
