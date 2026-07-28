/**
 * Batch-simulate levels from a dragged Excel file.
 * Reads 物品数据 / itemData, runs greedy Monte Carlo, writes metrics back.
 * Uses a Web Worker pool + optional fast mode (skip multi-step plan DFS).
 */

import {
  analyzeLevelAsync,
  buildReport,
  getLevelProfile,
} from "./analyze.js";

let analyzeReqId = 0;
/** @type {Worker[]} */
let workerPool = [];
/** @type {Map<number, { resolve: Function, reject: Function, onProgress?: Function, kind: string }>} */
const pendingById = new Map();

function poolSize() {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(2, Math.min(6, cores - 1));
}

function terminateAnalyzeWorker() {
  for (const [, pending] of pendingById) {
    try {
      pending.reject(new Error("cancelled"));
    } catch {
      /* already settled */
    }
  }
  pendingById.clear();
  for (const w of workerPool) {
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
  }
  workerPool = [];
}

function onWorkerMessage(event) {
  const msg = event.data || {};
  const pending = pendingById.get(msg.id);
  if (!pending) return;

  if (msg.type === "progress") {
    pending.onProgress?.(msg);
    return;
  }

  pendingById.delete(msg.id);
  if (msg.type === "error") {
    pending.reject(new Error(msg.message || "Worker 分析失败"));
    return;
  }
  if (msg.type === "chunk-result") {
    pending.resolve(msg.results || []);
    return;
  }
  if (msg.type === "result") {
    pending.resolve(msg.report);
    return;
  }
  pending.reject(new Error("未知 Worker 响应"));
}

function ensureWorkerPool() {
  if (workerPool.length) return workerPool;
  const n = poolSize();
  for (let i = 0; i < n; i += 1) {
    const w = new Worker(new URL("./analyze-worker.js", import.meta.url), {
      type: "module",
    });
    w.onmessage = onWorkerMessage;
    w.onerror = () => {
      // Fall through: callers may recreate pool next time
    };
    workerPool.push(w);
  }
  return workerPool;
}

function postToWorker(worker, payload, { onProgress } = {}) {
  const id = (analyzeReqId += 1);
  return new Promise((resolve, reject) => {
    pendingById.set(id, { resolve, reject, onProgress, kind: payload.type });
    worker.postMessage({ ...payload, id });
  });
}

function splitRanges(total, parts) {
  const n = Math.min(parts, Math.max(1, total));
  const ranges = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const left = n - i;
    const count = Math.ceil((total - start) / left);
    if (count <= 0) break;
    ranges.push({ startIndex: start, count });
    start += count;
  }
  return ranges;
}

/**
 * Parallel trial chunks across the worker pool; merge into one report.
 */
async function analyzeLevelParallel(rawLevel, options = {}) {
  const trials = options.trials ?? 20;
  const strategy = options.strategy ?? "greedy";
  const maxMoves = options.maxMoves ?? 2500;
  const seed = options.seed ?? 42;
  const planMaxLen = options.planMaxLen ?? 0;
  const onProgress = options.onProgress;

  let workers;
  try {
    workers = ensureWorkerPool();
  } catch {
    workers = null;
  }

  // Main-thread fallback (or tiny jobs): keep behavior correct
  if (!workers?.length || trials <= 2) {
    if (workers) {
      // still prefer one worker for UI responsiveness
      try {
        const w = workers[0];
        return await postToWorker(
          w,
          {
            type: "analyze",
            rawLevel,
            options: {
              trials,
              strategy,
              maxMoves,
              seed,
              planMaxLen,
              chunkSize: trials,
            },
          },
          { onProgress },
        );
      } catch (err) {
        if (err?.message === "cancelled") throw err;
      }
    }
    return analyzeLevelAsync(rawLevel, {
      trials,
      strategy,
      maxMoves,
      seed,
      planMaxLen,
      chunkSize: 1,
      onProgress,
    });
  }

  const ranges = splitRanges(trials, workers.length);
  let doneTrials = 0;
  const startedAt = performance.now();

  const chunkPromises = ranges.map((range, i) =>
    postToWorker(workers[i % workers.length], {
      type: "chunk",
      rawLevel,
      options: {
        startIndex: range.startIndex,
        count: range.count,
        strategy,
        maxMoves,
        seed,
        planMaxLen,
      },
    }).then((results) => {
      doneTrials += results.length;
      if (onProgress) {
        const elapsedMs = performance.now() - startedAt;
        onProgress({
          done: doneTrials,
          total: trials,
          elapsedMs,
          etaMs: doneTrials ? ((trials - doneTrials) * elapsedMs) / doneTrials : 0,
          msPerTrial: doneTrials ? elapsedMs / doneTrials : 0,
        });
      }
      return results;
    }),
  );

  const parts = await Promise.all(chunkPromises);
  const results = parts.flat().sort((a, b) => a.trialIndex - b.trialIndex);
  const profile = getLevelProfile(rawLevel);
  const report = buildReport(results, profile, {
    trials,
    strategy,
    maxMoves,
    seed,
    planMaxLen,
  });
  const { results: _drop, ...slim } = report;
  return slim;
}

/** @deprecated name kept for call sites clarity */
const analyzeLevelOffMain = analyzeLevelParallel;

const RESULT_FIELDS = [
  { key: "simDifficulty", zh: "模拟难度分", en: "simDifficulty", from: (s) => s.difficulty },
  { key: "simTier", zh: "模拟难度档", en: "simTier", from: (s) => s.tier },
  { key: "winRate", zh: "通关率", en: "winRate", from: (s) => pctNum(s.winRate) },
  { key: "deadlockRate", zh: "卡死率", en: "deadlockRate", from: (s) => pctNum(s.deadlockRate) },
  { key: "limitRate", zh: "步数上限耗尽", en: "limitRate", from: (s) => pctNum(s.limitRate) },
  {
    key: "avgDeadlockProgress",
    zh: "卡死时平均进度",
    en: "avgDeadlockProgress",
    from: (s) => pctNum(s.avgDeadlockProgress),
  },
  {
    key: "earlyStuckRate",
    zh: "半程前卡死",
    en: "earlyStuckRate",
    from: (s) => pctNum(s.earlyStuckRate),
  },
  { key: "p50WinMoves", zh: "通关中位步数", en: "p50WinMoves", from: (s) => s.p50WinMoves || "" },
  { key: "p90WinMoves", zh: "通关P90步数", en: "p90WinMoves", from: (s) => s.p90WinMoves || "" },
  { key: "avgWinMoves", zh: "通关平均步数", en: "avgWinMoves", from: (s) => round1(s.avgWinMoves) },
  { key: "bucket0_25", zh: "进度0-25%", en: "progress0_25", from: (_, b) => pctNum(b[0]?.rate) },
  { key: "bucket25_50", zh: "进度25-50%", en: "progress25_50", from: (_, b) => pctNum(b[1]?.rate) },
  { key: "bucket50_75", zh: "进度50-75%", en: "progress50_75", from: (_, b) => pctNum(b[2]?.rate) },
  { key: "bucket75_99", zh: "进度75-99%", en: "progress75_99", from: (_, b) => pctNum(b[3]?.rate) },
  { key: "bucket100", zh: "进度100%通关", en: "progress100", from: (_, b) => pctNum(b[4]?.rate) },
  { key: "structShelves", zh: "结构货架数", en: "structShelves", from: (_s, _b, p) => p.shelves },
  { key: "structItems", zh: "结构物品数", en: "structItems", from: (_s, _b, p) => p.items },
  { key: "structTypes", zh: "结构种类数", en: "structTypes", from: (_s, _b, p) => p.types },
  { key: "structDepth", zh: "结构最大深", en: "structDepth", from: (_s, _b, p) => p.maxDepth },
  { key: "structSpecials", zh: "结构特殊数", en: "structSpecials", from: (_s, _b, p) => p.specials },
  { key: "simError", zh: "模拟错误", en: "simError", from: () => "" },
];

function pctNum(n) {
  if (!Number.isFinite(n)) return "";
  return Math.round(n * 1000) / 10;
}

function round1(n) {
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 0 : "";
  return Math.round(n * 10) / 10;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} 秒`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  if (min < 60) return `${min} 分 ${rem} 秒`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

function cellStr(v) {
  if (v == null) return "";
  return String(v).replace(/^\uFEFF/, "").trim();
}

function normalizeHeader(s) {
  return cellStr(s)
    .toLowerCase()
    .replace(/[\s_\-]/g, "")
    .replace(/＊/g, "*");
}

function findHeaderIndex(row, names) {
  const targets = new Set(names.map(normalizeHeader));
  for (let i = 0; i < row.length; i += 1) {
    const s = normalizeHeader(row[i]);
    if (s && targets.has(s)) return i;
  }
  return -1;
}

/** Pick the worksheet that actually contains level item columns. */
function pickBestSheet(workbook, XLSX) {
  const names = workbook.SheetNames || [];
  const scored = [];
  for (const name of names) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });
    let score = 0;
    let itemCol = -1;
    for (let r = 0; r < Math.min(8, aoa.length); r += 1) {
      const row = aoa[r] || [];
      const ic = findHeaderIndex(row, ["itemData", "#itemData", "物品数据"]);
      if (ic >= 0) {
        score += 100;
        itemCol = ic;
        if (normalizeHeader(row[ic]).includes("itemdata")) score += 20;
      }
    }
    if (aoa.length > 3) score += Math.min(30, aoa.length);
    if (/sheet1/i.test(name) || name === "工作表1") score += 5;
    scored.push({ name, score, itemCol, rows: aoa.length, aoa });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.find((s) => s.itemCol >= 0) || scored[0];
  if (!best || best.itemCol < 0) {
    const detail = scored.map((s) => `${s.name}(${s.rows}行)`).join(", ");
    throw new Error(
      `未找到「物品数据 / itemData」列。已扫描工作表：${detail || "无"}。请确认表头含 itemData 或「物品数据」。`,
    );
  }
  return best;
}

function detectSheetLayout(aoa) {
  let keyRow = -1;
  let itemCol = -1;
  let levelCol = -1;
  let indexCol = -1;

  for (let r = 0; r < Math.min(8, aoa.length); r += 1) {
    const row = aoa[r] || [];
    const ic = findHeaderIndex(row, ["itemData", "#itemData", "物品数据"]);
    if (ic >= 0) {
      keyRow = r;
      itemCol = ic;
      levelCol = findHeaderIndex(row, ["#LevelId", "LevelId", "关卡号*", "关卡号"]);
      indexCol = findHeaderIndex(row, ["index", "表索引"]);
      if (normalizeHeader(row[ic]).includes("itemdata")) break;
    }
  }

  if (itemCol < 0) {
    throw new Error("未找到「物品数据 / itemData」列，请确认表格格式");
  }

  let zhRow = keyRow;
  for (let r = keyRow; r < Math.min(keyRow + 3, aoa.length); r += 1) {
    const row = aoa[r] || [];
    const ic = findHeaderIndex(row, ["itemData", "#itemData"]);
    if (ic >= 0) {
      keyRow = r;
      itemCol = ic;
      const lc = findHeaderIndex(row, ["#LevelId", "LevelId"]);
      const xc = findHeaderIndex(row, ["index"]);
      if (lc >= 0) levelCol = lc;
      if (xc >= 0) indexCol = xc;
    }
  }

  if (zhRow === keyRow && keyRow > 0) zhRow = 0;
  return {
    zhRow,
    keyRow,
    typeRow: keyRow > 0 ? keyRow - 1 : -1,
    dataStart: keyRow + 1,
    itemCol,
    levelCol,
    indexCol,
  };
}

function parseLevelJson(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // sometimes double-encoded quotes
    try {
      return JSON.parse(JSON.parse(`"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`));
    } catch {
      throw new Error("物品数据不是合法 JSON 三维数组");
    }
  }
}

function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    script.async = true;
    script.onload = () => {
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error("SheetJS 加载失败"));
    };
    script.onerror = () => reject(new Error("无法加载 SheetJS，请检查网络"));
    document.head.appendChild(script);
  });
}

const els = {
  drop: document.getElementById("batchDrop"),
  file: document.getElementById("batchFile"),
  status: document.getElementById("batchStatus"),
  progress: document.getElementById("batchProgress"),
  bar: document.getElementById("batchProgressBar"),
  tableWrap: document.getElementById("batchTableWrap"),
  table: document.getElementById("batchTable"),
  btnStart: document.getElementById("btnBatchStart"),
  btnStop: document.getElementById("btnBatchStop"),
  btnDownload: document.getElementById("btnBatchDownload"),
  trials: document.getElementById("batchTrials"),
  fastMode: document.getElementById("batchFastMode"),
};

const state = {
  XLSX: null,
  workbook: null,
  sheetName: "",
  aoa: null,
  layout: null,
  rows: [], // { excelRow, levelId, index, level, status, metrics }
  running: false,
  stop: false,
  fileName: "",
};

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

function readTrials() {
  const n = Number(els.trials?.value);
  if (!Number.isFinite(n)) return 20;
  return Math.min(500, Math.max(5, Math.round(n)));
}

function readFastMode() {
  return els.fastMode ? Boolean(els.fastMode.checked) : true;
}

function metricsFromReport(report) {
  const s = report.summary;
  const b = report.progressBuckets || [];
  const p = report.profile || {};
  const out = {};
  for (const f of RESULT_FIELDS) {
    out[f.key] = f.from(s, b, p);
  }
  return out;
}

function ensureResultColumns() {
  const { aoa, layout } = state;
  const keyRow = aoa[layout.keyRow];
  const zhRow = aoa[layout.zhRow] || aoa[0];
  const typeRow = layout.typeRow >= 0 ? aoa[layout.typeRow] : null;

  const existing = new Map();
  keyRow.forEach((cell, idx) => {
    const s = cellStr(cell);
    if (s) existing.set(s, idx);
  });

  const colIndex = {};
  for (const f of RESULT_FIELDS) {
    if (existing.has(f.en)) {
      colIndex[f.key] = existing.get(f.en);
      continue;
    }
    const idx = keyRow.length;
    keyRow.push(f.en);
    while (zhRow.length < idx) zhRow.push("");
    zhRow[idx] = f.zh;
    if (typeRow) {
      while (typeRow.length < idx) typeRow.push("");
      typeRow[idx] = f.key === "simTier" || f.key === "simError" ? "string" : "number";
    }
    colIndex[f.key] = idx;
  }
  state.colIndex = colIndex;
}

function buildRowModels() {
  const { aoa, layout } = state;
  const rows = [];
  for (let r = layout.dataStart; r < aoa.length; r += 1) {
    const row = aoa[r] || [];
    const rawItem = row[layout.itemCol];
    // also try #itemData if empty
    let level = null;
    let err = "";
    try {
      level = parseLevelJson(rawItem);
      if (!level && layout.itemCol >= 0) {
        // search sibling generated col
        const keyRow = aoa[layout.keyRow] || [];
        const gen = findHeaderIndex(keyRow, ["#itemData", "生成物品数据"]);
        if (gen >= 0) level = parseLevelJson(row[gen]);
      }
      if (!level) err = "无物品数据";
      else if (!Array.isArray(level)) err = "物品数据不是数组";
    } catch (e) {
      err = e.message || String(e);
    }

    const levelId =
      layout.levelCol >= 0 ? cellStr(row[layout.levelCol]) : String(r - layout.dataStart + 1);
    const index = layout.indexCol >= 0 ? cellStr(row[layout.indexCol]) : "";

    if (!level && !rawItem && row.every((c) => c == null || cellStr(c) === "")) {
      continue; // skip blank trailing rows
    }

    rows.push({
      excelRow: r,
      levelId,
      index,
      level,
      status: err ? "error" : "pending",
      error: err,
      metrics: null,
    });
  }
  state.rows = rows;
}

function renderTable() {
  if (!els.table) return;
  const head = `
    <thead><tr>
      <th>行</th>
      <th>关卡号</th>
      <th>表索引</th>
      <th>状态</th>
      ${RESULT_FIELDS.filter((f) => f.key !== "simError")
        .slice(0, 9)
        .map((f) => `<th>${f.zh}</th>`)
        .join("")}
      <th>错误</th>
    </tr></thead>`;

  const body = state.rows
    .map((row, i) => {
      const m = row.metrics || {};
      const statusLabel =
        row.status === "done"
          ? "完成"
          : row.status === "running"
            ? "模拟中"
            : row.status === "error"
              ? "失败"
              : row.status === "skipped"
                ? "跳过"
                : "等待";
      const cells = RESULT_FIELDS.filter((f) => f.key !== "simError")
        .slice(0, 9)
        .map((f) => `<td data-k="${f.key}">${m[f.key] ?? ""}</td>`)
        .join("");
      return `<tr data-i="${i}" class="batch-row status-${row.status}">
        <td>${row.excelRow + 1}</td>
        <td>${row.levelId}</td>
        <td>${row.index}</td>
        <td class="batch-status-cell">${statusLabel}</td>
        ${cells}
        <td class="batch-error-cell">${row.error || m.simError || ""}</td>
      </tr>`;
    })
    .join("");

  els.table.innerHTML = `${head}<tbody>${body}</tbody>`;
  if (els.tableWrap) els.tableWrap.hidden = false;
}

function updateRowDom(i) {
  const tr = els.table?.querySelector(`tr[data-i="${i}"]`);
  if (!tr) return;
  const row = state.rows[i];
  const m = row.metrics || {};
  tr.className = `batch-row status-${row.status}`;
  const statusLabel =
    row.status === "done"
      ? "完成"
      : row.status === "running"
        ? "模拟中"
        : row.status === "error"
          ? "失败"
          : row.status === "skipped"
            ? "跳过"
            : "等待";
  tr.querySelector(".batch-status-cell").textContent = statusLabel;
  tr.querySelector(".batch-error-cell").textContent = row.error || m.simError || "";
  for (const f of RESULT_FIELDS.filter((x) => x.key !== "simError").slice(0, 9)) {
    const td = tr.querySelector(`td[data-k="${f.key}"]`);
    if (td) td.textContent = m[f.key] ?? "";
  }
  if (row.status === "running") {
    tr.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function writeMetricsToAoa(row) {
  const excelRow = state.aoa[row.excelRow];
  const m = row.metrics || {};
  if (row.error) m.simError = row.error;
  for (const f of RESULT_FIELDS) {
    const col = state.colIndex[f.key];
    if (col == null) continue;
    while (excelRow.length < col) excelRow.push("");
    excelRow[col] = m[f.key] ?? "";
  }
}

async function parseFile(file) {
  const XLSX = await loadXlsxLib();
  state.XLSX = XLSX;
  const buf = await file.arrayBuffer();
  const workbook = XLSX.read(buf, { type: "array" });
  const best = pickBestSheet(workbook, XLSX);
  state.workbook = workbook;
  state.sheetName = best.name;
  state.aoa = best.aoa;
  state.fileName = file.name;
  state.layout = detectSheetLayout(best.aoa);
  ensureResultColumns();
  buildRowModels();
  renderTable();
  els.btnStart.disabled = state.rows.length === 0;
  els.btnDownload.disabled = true;
  els.btnStop.disabled = true;
  setStatus(
    `已载入 ${file.name} · 工作表 ${best.name} · ${state.rows.length} 关 · 物品列 ${state.layout.itemCol}`,
  );
}

async function runBatch() {
  if (state.running || !state.rows.length) return;
  const trials = readTrials();
  const fast = readFastMode();
  if (els.trials) els.trials.value = String(trials);

  state.running = true;
  state.stop = false;
  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  els.btnDownload.disabled = true;
  if (els.progress) els.progress.hidden = false;

  const total = state.rows.length;
  const startedAt = performance.now();
  let done = 0;
  const planMaxLen = fast ? 0 : 4;
  const maxMoves = fast ? 2500 : 5000;
  const workers = (() => {
    try {
      return ensureWorkerPool().length;
    } catch {
      return 1;
    }
  })();

  setStatus(
    `开始批量：${total} 关 × ${trials} 局 · ${fast ? "快速模式" : "精确模式"} · ${workers} 线程`,
  );

  for (let i = 0; i < total; i += 1) {
    if (state.stop) break;
    const row = state.rows[i];
    if (!row.level) {
      row.status = "error";
      row.error = row.error || "无有效关卡数据";
      writeMetricsToAoa(row);
      updateRowDom(i);
      done += 1;
      continue;
    }

    row.status = "running";
    updateRowDom(i);
    setStatus(
      `正在模拟关卡 ${row.levelId}（${i + 1}/${total}）· 每关 ${trials} 局 · ${fast ? "快速" : "精确"}…`,
    );

    try {
      const report = await analyzeLevelOffMain(row.level, {
        trials,
        strategy: "greedy",
        maxMoves,
        seed: 42,
        planMaxLen,
        onProgress: (p) => {
          if (state.stop) return;
          const levelPct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          setStatus(
            `关卡 ${row.levelId}（${i + 1}/${total}）· 局 ${p.done}/${p.total}（${levelPct}%）· ${workers} 核并行…`,
          );
        },
      });
      if (state.stop) break;
      row.metrics = metricsFromReport(report);
      row.status = "done";
      row.error = "";
    } catch (err) {
      if (state.stop || err?.message === "cancelled") {
        row.status = "pending";
        updateRowDom(i);
        break;
      }
      row.status = "error";
      row.error = err.message || String(err);
      row.metrics = row.metrics || {};
      row.metrics.simError = row.error;
    }

    writeMetricsToAoa(row);
    updateRowDom(i);
    done += 1;

    const elapsed = performance.now() - startedAt;
    const msPer = elapsed / done;
    const eta = (total - done) * msPer;
    const pctDone = Math.round((done / total) * 1000) / 10;
    if (els.bar) els.bar.style.width = `${pctDone}%`;
    setStatus(
      `进度 ${done}/${total}（${pctDone}%）· 已用 ${formatDuration(elapsed)} · 预计剩余 ${formatDuration(eta)}`,
    );
  }

  if (state.stop) terminateAnalyzeWorker();

  state.running = false;
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnDownload.disabled = false;

  if (state.stop) setStatus(`已停止：完成 ${done}/${total}。可下载当前结果。`);
  else setStatus(`全部完成：${total} 关 × ${trials} 局（${fast ? "快速" : "精确"}）。点击「下载结果表」。`);
}

function downloadResult() {
  if (!state.workbook || !state.XLSX) return;
  const XLSX = state.XLSX;
  const sheet = XLSX.utils.aoa_to_sheet(state.aoa);
  state.workbook.Sheets[state.sheetName] = sheet;
  const outName = state.fileName.replace(/\.xlsx$/i, "") + "-模拟结果.xlsx";
  XLSX.writeFile(state.workbook, outName);
}

function bindUi() {
  if (!els.drop) return;

  const onFile = (file) => {
    if (!file) return;
    setStatus(`读取 ${file.name}…`);
    parseFile(file).catch((err) => {
      setStatus(err.message || String(err));
      console.error(err);
    });
  };

  els.drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.drop.classList.add("is-dragover");
  });
  els.drop.addEventListener("dragleave", () => els.drop.classList.remove("is-dragover"));
  els.drop.addEventListener("drop", (e) => {
    e.preventDefault();
    els.drop.classList.remove("is-dragover");
    const file = e.dataTransfer?.files?.[0];
    onFile(file);
  });
  els.drop.addEventListener("click", () => els.file?.click());
  els.file?.addEventListener("change", () => onFile(els.file.files?.[0]));

  els.btnStart?.addEventListener("click", () => {
    runBatch().catch((err) => {
      state.running = false;
      setStatus(err.message || String(err));
      els.btnStart.disabled = false;
      els.btnStop.disabled = true;
    });
  });
  els.btnStop?.addEventListener("click", () => {
    state.stop = true;
    setStatus("正在停止…");
    terminateAnalyzeWorker();
  });
  els.btnDownload?.addEventListener("click", downloadResult);
}

bindUi();
