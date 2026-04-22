export interface GPUContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function requestGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!("gpu" in navigator) || !navigator.gpu) {
    throw new Error(
      "WebGPU is not available in this browser. Try a recent Chrome, Edge, or Chrome Canary.",
    );
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available.");

  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has("timestamp-query")) requiredFeatures.push("timestamp-query");
  if (adapter.features.has("float32-filterable")) requiredFeatures.push("float32-filterable");

  const device = await adapter.requestDevice({ requiredFeatures });

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not acquire a webgpu canvas context.");

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "opaque",
  });

  return { adapter, device, canvas, context, format };
}

export function resizeCanvas(canvas: HTMLCanvasElement, renderScale = 1.0): boolean {
  const dprBase = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.max(0.1, Math.min(2, renderScale));
  const w = Math.max(1, Math.floor(canvas.clientWidth * dprBase * scale));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dprBase * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}
