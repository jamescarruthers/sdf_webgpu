import { Clock } from "./engine/Clock";
import { createEngine, type RenderMode } from "./engine/Engine";
import { Input } from "./engine/Input";
import { demoScene, spherePhase1 } from "./sdf/Scene";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errBox = document.getElementById("error") as HTMLDivElement;

function showError(msg: string): void {
  errBox.style.display = "flex";
  errBox.textContent = msg;
  // eslint-disable-next-line no-console
  console.error(msg);
}

async function boot(): Promise<void> {
  let engine;
  try {
    engine = await createEngine(canvas);
  } catch (e) {
    showError(`${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const input = new Input(canvas);
  const clock = new Clock();

  const url = new URL(window.location.href);
  const sceneName = url.searchParams.get("scene") ?? "demo";
  const scene = sceneName === "sphere" ? spherePhase1() : demoScene();
  engine.setScene(scene);

  // M toggles render mode between analytic and atlas. First toggle lazily
  // bakes the atlas so we don't pay the cost at boot unless the user wants it.
  let mode: RenderMode = "analytic";
  let bakeMs = 0;
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyM") {
      if (mode === "analytic") {
        const t0 = performance.now();
        engine!.bakeAtlas(scene.getRecords());
        bakeMs = performance.now() - t0;
        engine!.setMode("atlas");
        mode = "atlas";
      } else {
        engine!.setMode("analytic");
        mode = "analytic";
      }
    }
  });

  engine.gpu.device.lost.then((info) => {
    showError(`WebGPU device lost: ${info.message}`);
  });

  const hudUpdate = () => {
    const s = engine!.stats();
    const atlasLine =
      s.mode === "atlas"
        ? `\natlas  ${s.atlasAllocated}/${s.atlasCapacity} slots   bake ${bakeMs.toFixed(1)} ms`
        : "\npress M to toggle brick atlas";
    hud.textContent =
      `WebGPU SDF  ${s.resolution[0]}×${s.resolution[1]}\n` +
      `fps  ${clock.fps.toFixed(1)}   frame  ${clock.frameMs.toFixed(2)} ms\n` +
      `mode  ${s.mode}\n` +
      `scene records  ${s.sceneRecords}\n` +
      `debug  ${s.debugMode}   (1=steps, 2=normals, 3=off)\n` +
      `cam  ${engine!.camera.position.map((v) => v.toFixed(1)).join(", ")}` +
      atlasLine;
  };

  const frame = () => {
    clock.tick();
    engine!.update(input, Math.min(clock.dt, 0.1));
    engine!.render();
    if ((clock.frame & 7) === 0) hudUpdate();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
