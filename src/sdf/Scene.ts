import {
  boxRec,
  capsuleRec,
  planeYRec,
  roundBoxRec,
  SceneBuilder,
  smoothSubtractRec,
  smoothUnionRec,
  sphereRec,
  subtractRec,
  torusRec,
  unionRec,
} from "./Primitives";

/** A minimal analytic sphere scene — the Phase 1 baseline. */
export function spherePhase1(): SceneBuilder {
  const s = new SceneBuilder();
  s.push(sphereRec([0, 1, 0], 1));
  return s;
}

/**
 * Phase 2 demo scene: a ground plane, a smooth-merged sphere cluster, a box
 * with spherical holes subtracted, a torus ring, and a capsule. Exercises
 * every CSG code path and puts > 20 primitives on screen so we can stress the
 * step-count heatmap.
 */
export function demoScene(): SceneBuilder {
  const s = new SceneBuilder();

  // Ground
  s.push(planeYRec(0));

  // Smooth-union blob cluster
  s.push(sphereRec([-3, 1.1, 0], 0.9));
  s.push(sphereRec([-2.1, 1.2, 0.4], 0.7));
  s.push(smoothUnionRec(0.6));
  s.push(sphereRec([-2.6, 1.8, -0.4], 0.6));
  s.push(smoothUnionRec(0.5));
  s.push(sphereRec([-3.6, 1.5, -0.6], 0.55));
  s.push(smoothUnionRec(0.4));
  s.push(sphereRec([-2.2, 2.2, 0.8], 0.5));
  s.push(smoothUnionRec(0.5));
  s.push(unionRec()); // combine blob with ground

  // Rounded box with spherical holes
  s.push(roundBoxRec([0, 1.1, 0], [0.9, 1.0, 0.9], 0.15));
  s.push(sphereRec([0.6, 1.5, 0.6], 0.45));
  s.push(subtractRec());
  s.push(sphereRec([-0.6, 0.7, 0.6], 0.45));
  s.push(subtractRec());
  s.push(sphereRec([0.6, 1.5, -0.6], 0.45));
  s.push(smoothSubtractRec(0.2));
  s.push(sphereRec([-0.6, 0.7, -0.6], 0.45));
  s.push(smoothSubtractRec(0.2));
  s.push(unionRec());

  // Torus and capsule
  s.push(torusRec([3, 1.4, 0], 1.1, 0.25));
  s.push(capsuleRec([3, 0.2, -1], [3, 2.8, 1], 0.12));
  s.push(smoothUnionRec(0.25));
  s.push(unionRec());

  // A row of tiny spheres to push record count past the 20-primitive
  // acceptance threshold and exercise large op-trees.
  for (let i = 0; i < 6; i++) {
    const x = -5 + i * 2;
    s.push(sphereRec([x, 0.28, -3.5], 0.28));
    s.push(smoothUnionRec(0.18));
  }

  // A second row on the other side
  for (let i = 0; i < 6; i++) {
    const x = -5 + i * 2;
    s.push(boxRec([x, 0.3, 3.5], [0.25, 0.3, 0.25]));
    s.push(unionRec());
  }

  return s;
}
