/**
 * Off-main-thread Monte Carlo / fork analysis for batch (and any UI caller).
 */
import { analyzeLevelAsync, analyzeForkAsync } from "./analyze.js?v=20260802p";

function slimReport(report) {
  if (!report) return report;
  const { results, ...rest } = report;
  return rest;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== "analyze") return;

  const { id, rawLevel, options = {} } = msg;
  const mode = options.mode === "fork" ? "fork" : "montecarlo";
  try {
    const onProgress = (p) => {
      self.postMessage({
        type: "progress",
        id,
        done: p.done,
        total: p.total,
        elapsedMs: p.elapsedMs,
        etaMs: p.etaMs,
        msPerTrial: p.msPerTrial,
      });
    };

    const report =
      mode === "fork"
        ? await analyzeForkAsync(rawLevel, {
            maxBranches: options.maxBranches ?? options.trials ?? 64,
            maxForkWidth: options.maxForkWidth ?? 8,
            maxMoves: options.maxMoves,
            seed: options.seed,
            chunkSize: options.chunkSize ?? 1,
            enabledOps: options.enabledOps,
            onProgress,
          })
        : await analyzeLevelAsync(rawLevel, {
            trials: options.trials,
            strategy: options.strategy,
            maxMoves: options.maxMoves,
            seed: options.seed,
            chunkSize: options.chunkSize ?? 1,
            enabledOps: options.enabledOps,
            onProgress,
          });
    // Default keep full report; batch opts into slimResults to shrink transfer.
    // Fork mode must keep results (with traces); never slim fork reports from UI.
    const out = options.slimResults && mode !== "fork" ? slimReport(report) : report;
    self.postMessage({ type: "result", id, report: out });
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: err?.message || String(err),
    });
  }
};
