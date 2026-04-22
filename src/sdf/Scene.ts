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

  for (let i = 0; i < 6; i++) {
    const x = -5 + i * 2;
    s.push(boxRec([x, 0.3, 3.5], [0.25, 0.3, 0.25]));
    s.push(unionRec());
  }

  return s;
}

/**
 * Phase 4 large-extent scene: a ground plane plus a regular lattice of
 * landmarks spanning ~500 m in X/Z, tall enough to flex the vertical clipmap
 * levels too. Uses only a few primitives per landmark so the op-tree stays
 * cheap — the point is to populate lots of world-bricks for the clipmap, not
 * to stress the evaluator.
 */
export function largeScene(): SceneBuilder {
  const s = new SceneBuilder();
  s.push(planeYRec(0));

  const spacing = 20; // metres between landmarks
  const reach = 12;   // landmarks per half-axis → 25×25 grid

  for (let ix = -reach; ix <= reach; ix++) {
    for (let iz = -reach; iz <= reach; iz++) {
      const x = ix * spacing + ((iz & 1) ? spacing * 0.5 : 0);
      const z = iz * spacing;
      // Vary the landmark type by a deterministic hash of the grid cell.
      const h = ((ix * 928371 + iz * 56432197) >>> 0) % 4;
      if (h === 0) {
        // Tower
        s.push(roundBoxRec([x, 3, z], [1.2, 3, 1.2], 0.3));
        s.push(unionRec());
      } else if (h === 1) {
        // Arch (torus upright)
        s.push(torusRec([x, 2.2, z], 2.2, 0.35));
        s.push(unionRec());
      } else if (h === 2) {
        // Stacked spheres blended
        s.push(sphereRec([x, 1.0, z], 1.0));
        s.push(sphereRec([x, 2.4, z], 0.7));
        s.push(smoothUnionRec(0.6));
        s.push(sphereRec([x, 3.4, z], 0.5));
        s.push(smoothUnionRec(0.5));
        s.push(unionRec());
      } else {
        // Capsule with a cored-out center
        s.push(capsuleRec([x, 0.1, z], [x, 4.5, z], 0.6));
        s.push(sphereRec([x, 2.2, z], 0.7));
        s.push(smoothSubtractRec(0.2));
        s.push(unionRec());
      }
    }
  }

  return s;
}
