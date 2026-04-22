import { Clock } from "./engine/Clock";
import { createEngine, type RenderMode } from "./engine/Engine";
import { Input } from "./engine/Input";
import { demoScene, largeScene, spherePhase1 } from "./sdf/Scene";

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
  const sceneName = url.searchParams.get("scene") ?? "large";
  const scene =
    sceneName === "sphere" ? spherePhase1() :
    sceneName === "demo" ? demoScene() :
    largeScene();
  engine.setScene(scene);

  // Default to the geometry-clipmap render path so the scene streams around
  // the camera. Press M to fall back to the analytic fragment shader for
  // comparison.
  engine.initClipmap();
  engine.warmClipmap(80);
  engine.setMode("clipmap");

  let mode: RenderMode = "clipmap";
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyM") {
      mode = mode === "clipmap" ? "analytic" : "clipmap";
      engine!.setMode(mode);
    }
  });

  engine.gpu.device.lost.then((info) => {
    showError(`WebGPU device lost: ${info.message}`);
  });

  const hudUpdate = () => {
    const s = engine!.stats();
    const clipmapLine =
      s.mode === "clipmap"
        ? `\nclipmap  ${s.clipmapAllocated}/${s.clipmapCapacity} slots · queue ${s.clipmapQueueDepth}` +
          `\n  per-level  ${s.clipmapLevelCounts.join(" / ")}` +
          `\n  stream ${s.lastBakeMs.toFixed(1)} ms/frame`
        : "\npress M to return to clipmap";
    hud.textContent =
      `WebGPU SDF  ${s.resolution[0]}×${s.resolution[1]}\n` +
      `fps  ${clock.fps.toFixed(1)}   frame  ${clock.frameMs.toFixed(2)} ms\n` +
      `mode  ${s.mode}\n` +
      `scene  ${sceneName}   records ${s.sceneRecords}\n` +
      `debug  ${s.debugMode}   (1=steps, 2=normals, 3=off)\n` +
      `cam  ${engine!.camera.position.map((v) => v.toFixed(1)).join(", ")}` +
      clipmapLine;
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
