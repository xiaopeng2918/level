/**
 * Off-main-thread entry for Monte Carlo / fork analysis (shared by UI + batch).
 */
import { analyzeLevelAsync, analyzeForkAsync } from "./analyze.js?v=20260802p";

const WORKER_VER = "20260802p";

let analyzeWorker = null;
let analyzeReqId = 0;
/** @type {{ id: number, reject: (err: Error) => void, onMessage: (e: MessageEvent) => void } | null} */
let pendingAnalyze = null;

export function terminateAnalyzeWorker() {
  const pending = pendingAnalyze;
  pendingAnalyze = null;
  if (pending && analyzeWorker) {
    analyzeWorker.removeEventListener("message", pending.onMessage);
    try {
      pending.reject(new Error("cancelled"));
    } catch {
      /* already settled */
    }
  }
  if (analyzeWorker) {
    try {
      analyzeWorker.terminate();
    } catch {
      /* ignore */
    }
    analyzeWorker = null;
  }
}

function getAnalyzeWorker() {
  if (analyzeWorker) return analyzeWorker;
  // Query bust is required: browsers aggressively cache module workers.
  analyzeWorker = new Worker(new URL(`./analyze-worker.js?v=${WORKER_VER}`, import.meta.url), {
    type: "module",
  });
  analyzeWorker.addEventListener("error", () => {
    terminateAnalyzeWorker();
  });
  return analyzeWorker;
}

/**
 * Run analyzeLevelAsync / analyzeForkAsync in a Worker when possible; fall back to main thread.
 * @param {object} options
 * @param {"montecarlo"|"fork"} [options.mode]
 * @param {boolean} [options.slimResults=false] Drop per-trial rows (batch only).
 */
export function analyzeLevelOffMain(rawLevel, options = {}) {
  const shouldSlim = options.slimResults === true;
  const mode = options.mode === "fork" ? "fork" : "montecarlo";

  try {
    const worker = getAnalyzeWorker();
    const id = (analyzeReqId += 1);
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.id !== id) return;
        if (msg.type === "progress") {
          options.onProgress?.(msg);
          return;
        }
        if (pendingAnalyze?.id === id) pendingAnalyze = null;
        worker.removeEventListener("message", onMessage);
        if (msg.type === "result") resolve(msg.report);
        else reject(new Error(msg.message || "Worker 分析失败"));
      };
      pendingAnalyze = { id, reject, onMessage };
      worker.addEventListener("message", onMessage);
      worker.postMessage({
        type: "analyze",
        id,
        rawLevel,
        options: {
          mode,
          trials: options.trials,
          maxBranches: options.maxBranches ?? options.trials,
          maxForkWidth: options.maxForkWidth,
          strategy: options.strategy,
          maxMoves: options.maxMoves,
          seed: options.seed,
          chunkSize: options.chunkSize ?? 2,
          enabledOps: options.enabledOps,
          slimResults: shouldSlim,
        },
      });
    });
  } catch {
    if (mode === "fork") {
      return analyzeForkAsync(rawLevel, {
        ...options,
        maxBranches: options.maxBranches ?? options.trials ?? 64,
        chunkSize: options.chunkSize ?? 1,
      });
    }
    return analyzeLevelAsync(rawLevel, {
      ...options,
      chunkSize: options.chunkSize ?? 1,
    });
  }
}
