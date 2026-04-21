// Brick atlas sampling.
//
// The brick map is a flat u32 buffer indexed by (ix, iy, iz) of the world-
// space brick grid. Values are either a sentinel (EMPTY, SOLID) or a slot
// index into the atlas. The atlas itself is a 3D r16float texture where every
// slot is an 8³ block of distance samples.
//
// Bind layout (group 1):
//   @binding(0) brickParams : uniform  (grid dimensions, world origin, etc.)
//   @binding(1) brickMap    : read-only-storage buffer<u32>
//   @binding(2) atlasTexture: texture_3d<f32>
//   @binding(3) atlasSampler: sampler (linear filtering)

struct BrickParams {
  worldOrigin: vec4<f32>,      // xyz = world min corner, w = BRICK_WORLD
  worldBricks: vec4<u32>,      // xyz = world grid dims, w = atlas enabled flag
  atlasSlots: vec4<u32>,       // xyz = slots per atlas axis, w = samples per brick
  atlasTexels: vec4<f32>,      // xyz = atlas texture dims, w = sampleSpacing
};

const BRICK_EMPTY_U: u32 = 0xffffffffu;
const BRICK_SOLID_U: u32 = 0xfffffffeu;

@group(1) @binding(0) var<uniform> brickParams: BrickParams;
@group(1) @binding(1) var<storage, read> brickMap: array<u32>;
@group(1) @binding(2) var atlasTexture: texture_3d<f32>;
@group(1) @binding(3) var atlasSampler: sampler;

struct BrickSample {
  distance: f32,
  kind: u32,  // 0 = outside-world, 1 = empty, 2 = solid, 3 = surface
};

fn brickLinearIndex(ix: u32, iy: u32, iz: u32) -> u32 {
  let wx = brickParams.worldBricks.x;
  let wy = brickParams.worldBricks.y;
  return (iz * wy + iy) * wx + ix;
}

fn slotOrigin(slot: u32) -> vec3<u32> {
  let sx = brickParams.atlasSlots.x;
  let sy = brickParams.atlasSlots.y;
  let ox = slot % sx;
  let oy = (slot / sx) % sy;
  let oz = slot / (sx * sy);
  let n = brickParams.atlasSlots.w;
  return vec3<u32>(ox * n, oy * n, oz * n);
}

fn sampleBrick(worldP: vec3<f32>) -> BrickSample {
  var out: BrickSample;
  let brickWorld = brickParams.worldOrigin.w;
  let invBrick = 1.0 / brickWorld;

  let rel = (worldP - brickParams.worldOrigin.xyz) * invBrick;
  let dims = vec3<f32>(
    f32(brickParams.worldBricks.x),
    f32(brickParams.worldBricks.y),
    f32(brickParams.worldBricks.z),
  );
  if (any(rel < vec3<f32>(0.0)) || any(rel >= dims)) {
    out.distance = brickWorld;
    out.kind = 0u;
    return out;
  }

  let bi = vec3<u32>(u32(floor(rel.x)), u32(floor(rel.y)), u32(floor(rel.z)));
  let local = rel - vec3<f32>(bi); // 0..1 inside the brick

  let idx = brickLinearIndex(bi.x, bi.y, bi.z);
  let entry = brickMap[idx];
  if (entry == BRICK_EMPTY_U) {
    out.distance = brickWorld * 0.5; // conservative step toward the brick's far face
    out.kind = 1u;
    return out;
  }
  if (entry == BRICK_SOLID_U) {
    out.distance = -brickWorld * 0.25;
    out.kind = 2u;
    return out;
  }

  let n = brickParams.atlasSlots.w;
  let origin = slotOrigin(entry);
  // Sample position in texel space: origin + local * (n-1), plus 0.5 texel offset
  // for hardware trilinear to land on sample centers.
  let fn_ = f32(n - 1u);
  let texel = vec3<f32>(origin) + local * fn_ + vec3<f32>(0.5);
  let uvw = texel / brickParams.atlasTexels.xyz;
  out.distance = textureSampleLevel(atlasTexture, atlasSampler, uvw, 0.0).r;
  out.kind = 3u;
  return out;
}

/// Samples the brick atlas and returns a signed distance. Missing coverage
/// degrades gracefully: outside the world we advance by one brick, empty
/// bricks advance by a half-brick, solid bricks return a negative value so
/// the sphere-trace terminates.
fn brickDistance(worldP: vec3<f32>) -> f32 {
  let s = sampleBrick(worldP);
  return s.distance;
}
