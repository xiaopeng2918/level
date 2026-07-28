/**
 * Off-main-thread Monte Carlo chunks for batch (and any UI caller).
 * Supports full-level analyze and trial-range chunks for multi-core pooling.
 */
import { analyzeLevelAsync, runTrialChunk, getLevelProfile } from "./analyze.js";

function slimReport(report) {
  if (!report) return report;
  const { results, ...rest } = report;
  return rest;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const { id, rawLevel, options = {} } = msg;

  try {
    if (msg.type === "chunk") {
      const results = runTrialChunk(rawLevel, {
        startIndex: options.startIndex ?? 0,
        count: options.count ?? 1,
        strategy: options.strategy,
        maxMoves: options.maxMoves,
        seed: options.seed,
        planMaxLen: options.planMaxLen,
      });
      self.postMessage({
        type: "chunk-result",
        id,
        results,
        startIndex: options.startIndex ?? 0,
        count: results.length,
      });
      return;
    }

    if (msg.type === "analyze") {
      const report = await analyzeLevelAsync(rawLevel, {
        trials: options.trials,
        strategy: options.strategy,
        maxMoves: options.maxMoves,
        seed: options.seed,
        planMaxLen: options.planMaxLen,
        // Avoid yielding inside worker — keeps CPU saturated
        chunkSize: options.chunkSize ?? Math.max(1, options.trials || 1),
        onProgress: (p) => {
          self.postMessage({
            type: "progress",
            id,
            done: p.done,
            total: p.total,
            elapsedMs: p.elapsedMs,
            etaMs: p.etaMs,
            msPerTrial: p.msPerTrial,
          });
        },
      });
      self.postMessage({ type: "result", id, report: slimReport(report) });
      return;
    }

    if (msg.type === "profile") {
      self.postMessage({
        type: "profile-result",
        id,
        profile: getLevelProfile(rawLevel),
      });
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: err?.message || String(err),
    });
  }
};
