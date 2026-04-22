import { Clock } from "./engine/Clock";
import { createEngine, type RenderMode } from "./engine/Engine";
import { Input } from "./engine/Input";
import { PerfMonitor } from "./engine/PerfMonitor";
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

function hideError(): void {
  errBox.style.display = "none";
  errBox.textContent = "";
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

  // Choose a conservative starting render scale so a 4K display doesn't hand
  // the GPU a multi-billion-op first frame before the watchdog has a chance
  // to react. The target is roughly 1080p worth of pixels; anything bigger
  // gets shrunk to that until PerfMonitor confirms the hardware can handle
  // more.
  const initialScale = PerfMonitor.initialScaleForViewport(
    canvas.clientWidth,
    canvas.clientHeight,
    window.devicePixelRatio,
  );
  const perf = new PerfMonitor(initialScale);
  engine.setRenderScale(perf.renderScale);

  const url = new URL(window.location.href);
  const sceneName = url.searchParams.get("scene") ?? "large";
  const scene =
    sceneName === "sphere" ? spherePhase1() :
    sceneName === "demo" ? demoScene() :
    largeScene();
  engine.setScene(scene);

  engine.initClipmap();
  engine.warmClipmap(80);
  engine.setMode("clipmap");

  let mode: RenderMode = "clipmap";
  let running = true;

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyM") {
      mode = mode === "clipmap" ? "analytic" : "clipmap";
      engine!.setMode(mode);
    }
    if (e.code === "KeyR" && !running) {
      perf.resume();
      hideError();
      running = true;
      requestAnimationFrame(frame);
    }
  });

  engine.gpu.device.lost.then((info) => {
    showError(`WebGPU device lost: ${info.message}`);
    running = false;
  });

  const hudUpdate = () => {
    const s = engine!.stats();
    const scalePct = (perf.renderScale * 100).toFixed(0);
    const renderPx = `${s.resolution[0]}×${s.resolution[1]}`;
    const cssPx = `${canvas.clientWidth}×${canvas.clientHeight}`;
    const clipmapLine =
      s.mode === "clipmap"
        ? `\nclipmap  ${s.clipmapAllocated}/${s.clipmapCapacity} slots · queue ${s.clipmapQueueDepth}` +
          `\n  per-level  ${s.clipmapLevelCounts.join(" / ")}` +
          `\n  stream ${s.lastBakeMs.toFixed(1)} ms/frame`
        : "\npress M to return to clipmap";
    hud.textContent =
      `WebGPU SDF  render ${renderPx} · css ${cssPx}\n` +
      `fps  ${clock.fps.toFixed(1)}   frame  ${clock.frameMs.toFixed(2)} ms\n` +
      `render scale  ${scalePct}%\n` +
      `mode  ${s.mode}\n` +
      `scene  ${sceneName}   records ${s.sceneRecords}\n` +
      `debug  ${s.debugMode}   (1=steps, 2=normals, 3=off)\n` +
      `cam  ${engine!.camera.position.map((v) => v.toFixed(1)).join(", ")}` +
      clipmapLine;
  };

  const frame = () => {
    if (!running) return;
    clock.tick();

    const obs = perf.observe(clock.frameMs, clock.dt * 1000);
    if (obs.scaleChanged) engine!.setRenderScale(perf.renderScale);
    if (obs.paused) {
      running = false;
      showError(obs.reason ?? "Rendering paused.");
      return;
    }

    engine!.update(input, Math.min(clock.dt, 0.1));
    engine!.render();
    if ((clock.frame & 7) === 0) hudUpdate();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
