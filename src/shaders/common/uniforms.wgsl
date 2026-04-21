// Camera + frame uniforms shared by every fragment pipeline.
// Must match the Float32Array packed in Engine.ts (24 floats, 96 bytes).

struct Uniforms {
  camPos: vec4<f32>,      // xyz = eye, w = time
  camRight: vec4<f32>,    // xyz = right, w = tanHalfFov
  camUp: vec4<f32>,       // xyz = up,    w = aspect
  camForward: vec4<f32>,  // xyz = forward, w = debugMode (0 off, 1 steps, 2 normals)
  params: vec4<f32>,      // x = maxSteps, y = maxDist, z = epsilon, w = resolution.x
  params2: vec4<f32>,     // x = resolution.y, yzw reserved
};

@group(0) @binding(0) var<uniform> U: Uniforms;
