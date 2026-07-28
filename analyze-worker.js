/**
 * Off-main-thread Monte Carlo analysis for batch (and any UI caller).
 */
import { analyzeLevelAsync } from "./analyze.js";

function slimReport(report) {
  if (!report) return report;
  const { results, ...rest } = report;
  return rest;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== "analyze") return;

  const { id, rawLevel, options = {} } = msg;
  try {
    const report = await analyzeLevelAsync(rawLevel, {
      trials: options.trials,
      strategy: options.strategy,
      maxMoves: options.maxMoves,
      seed: options.seed,
      chunkSize: options.chunkSize ?? 1,
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
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: err?.message || String(err),
    });
  }
};
