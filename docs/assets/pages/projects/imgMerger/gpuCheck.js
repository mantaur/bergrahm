/* gpuCheck.js — async YOLO encoding capability detection
 * Resolves with { tier: 'fast'|'slow'|'unknown', reason: string }
 */

async function detectEncodingCapability() {
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return { tier: "fast", reason: "mobile" };
  }

  if (!navigator.gpu) {
    return { tier: "slow", reason: "no-webgpu" };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { tier: "slow", reason: "no-adapter" };

    // adapter.info is the newer property; requestAdapterInfo() the older method
    const info = adapter.info ?? (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : null);

    if (!info) return { tier: "unknown", reason: "no-info" };

    const vendor = (info.vendor || "").toLowerCase();
    const arch = (info.architecture || "").toLowerCase();

    // Google SwiftShader: CPU-based software WebGPU renderer
    if (vendor === "google" && arch === "swiftshader") {
      return { tier: "slow", reason: "swiftshader" };
    }

    // Other known software / CPU renderers
    if (arch.includes("software") || arch.includes("llvm") || arch.includes("cpu") || vendor === "llvmpipe" || vendor.includes("software")) {
      return { tier: "slow", reason: "software-renderer" };
    }

    return { tier: "fast", reason: "real-gpu", vendor, arch };
  } catch (_) {
    return { tier: "unknown", reason: "error" };
  }
}
