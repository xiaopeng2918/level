/**
 * Batch-simulate levels from a dragged Excel file.
 * Modes:
 * - forkTiers: 简单/普通/困难 × N fork branches → 9 columns (win/fail/winRate × 3)
 * - montecarlo: greedy Monte Carlo with UI-enabled ops
 */

import {
  defaultEnabledOps,
  normalizeEnabledOps,
  SIM_OP_PRESETS,
  aggregateOpSkillMix,
} from "./analyze.js?v=20260803c";
import { analyzeLevelOffMain, terminateAnalyzeWorker } from "./analyze-client.js?v=20260803c";

function readEnabledOpsFromUi() {
  const ops = defaultEnabledOps();
  document.querySelectorAll("#simOpsList input[data-sim-op]").forEach((input) => {
    ops[input.dataset.simOp] = input.checked;
  });
  return normalizeEnabledOps(ops);
}

/** Three op tiers for fork-compare batch (简单 / 普通 / 困难). */
const FORK_TIER_DEFS = [
  { id: "easy", label: "简单", prefix: "easy", zh: "简单" },
  { id: "normal", label: "普通", prefix: "normal", zh: "普通" },
  { id: "hard", label: "困难", prefix: "hard", zh: "困难" },
];

const FORK_TIER_FIELDS = FORK_TIER_DEFS.flatMap((tier) => [
  {
    key: `${tier.prefix}WinCount`,
    zh: `${tier.zh}胜利次数`,
    en: `${tier.prefix}WinCount`,
    type: "number",
  },
  {
    key: `${tier.prefix}FailCount`,
    zh: `${tier.zh}失败次数`,
    en: `${tier.prefix}FailCount`,
    type: "number",
  },
  {
    key: `${tier.prefix}WinRate`,
    zh: `${tier.zh}通关率`,
    en: `${tier.prefix}WinRate`,
    type: "number",
  },
  {
    key: `${tier.prefix}WinEasyOpPct`,
    zh: `${tier.zh}胜局简单操作%`,
    en: `${tier.prefix}WinEasyOpPct`,
    type: "number",
  },
  {
    key: `${tier.prefix}WinNormalOpPct`,
    zh: `${tier.zh}胜局普通多出%`,
    en: `${tier.prefix}WinNormalOpPct`,
    type: "number",
  },
  {
    key: `${tier.prefix}WinHardOpPct`,
    zh: `${tier.zh}胜局困难多出%`,
    en: `${tier.prefix}WinHardOpPct`,
    type: "number",
  },
]);

const MC_RESULT_FIELDS = [
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

const FORK_RESULT_FIELDS = [
  ...FORK_TIER_FIELDS,
  { key: "simError", zh: "模拟错误", en: "simError", type: "string" },
];

function readBatchMode() {
  const v = document.getElementById("batchMode")?.value;
  return v === "montecarlo" ? "montecarlo" : "forkTiers";
}

function activeResultFields() {
  return readBatchMode() === "forkTiers" ? FORK_RESULT_FIELDS : MC_RESULT_FIELDS;
}

function syncBatchModeUi() {
  const mode = readBatchMode();
  const label = document.getElementById("batchTrialsLabelText");
  const trials = document.getElementById("batchTrials");
  const hint = document.getElementById("batchModeHint");
  if (mode === "forkTiers") {
    if (label) label.textContent = "每档支路数";
    if (trials && (Number(trials.value) === 20 || !trials.value)) trials.value = "64";
    if (hint) {
      hint.textContent =
        "拖入 Excel（含「物品数据 / itemData」）。三档分叉：简单 / 普通 / 困难各跑 N 条支路；每档写回胜利/失败/通关率，以及胜局中简单操作、普通多出（翻层可消）、困难多出（选架翻层）占比。";
    }
  } else {
    if (label) label.textContent = "每关局数";
    if (trials && Number(trials.value) === 64) trials.value = "20";
    if (hint) {
      hint.textContent =
        "拖入 Excel（含「物品数据 / itemData」）。多局统计：使用上方「模拟可用操作」勾选，结果写回多列指标。";
    }
  }
}

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

  const sources = [
    "./vendor/xlsx.full.min.js",
    "./node_modules/xlsx/dist/xlsx.full.min.js",
    "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
  ];

  const tryLoad = (i) =>
    new Promise((resolve, reject) => {
      if (i >= sources.length) {
        reject(new Error("无法加载 SheetJS（本地与 CDN 均失败）"));
        return;
      }
      const script = document.createElement("script");
      script.src = sources[i];
      script.async = true;
      script.onload = () => {
        if (window.XLSX) resolve(window.XLSX);
        else tryLoad(i + 1).then(resolve, reject);
      };
      script.onerror = () => {
        script.remove();
        tryLoad(i + 1).then(resolve, reject);
      };
      document.head.appendChild(script);
    });

  return tryLoad(0);
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
  const el = document.getElementById("batchStatus") || els.status;
  if (el) el.textContent = text;
}

function readTrials() {
  const n = Number(els.trials?.value);
  const fallback = readBatchMode() === "forkTiers" ? 64 : 20;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(5, Math.round(n)));
}

function metricsFromReport(report) {
  const s = report.summary;
  const b = report.progressBuckets || [];
  const p = report.profile || {};
  const out = {};
  for (const f of MC_RESULT_FIELDS) {
    out[f.key] = f.from ? f.from(s, b, p) : "";
  }
  return out;
}

/** Count win/fail/rate + win-path op skill mix from fork leaves. */
function forkLeafCounts(report) {
  const results = report?.results || [];
  const total = results.length;
  const winLeaves = results.filter((r) => r.result === "win");
  const wins = winLeaves.length;
  const fails = total - wins;
  const winOpMix =
    report?.summary?.winOpMix ||
    aggregateOpSkillMix(winLeaves.map((r) => r.opMix));
  return {
    winCount: wins,
    failCount: fails,
    winRate: pctNum(total ? wins / total : 0),
    winEasyOpPct: winOpMix.total ? winOpMix.easyPct : "",
    winNormalOpPct: winOpMix.total ? winOpMix.normalExtraPct : "",
    winHardOpPct: winOpMix.total ? winOpMix.hardExtraPct : "",
  };
}

function ensureResultColumns() {
  const { aoa, layout } = state;
  const keyRow = aoa[layout.keyRow];
  const zhRow = aoa[layout.zhRow] || aoa[0];
  const typeRow = layout.typeRow >= 0 ? aoa[layout.typeRow] : null;
  const fields = activeResultFields();

  const existing = new Map();
  keyRow.forEach((cell, idx) => {
    const s = cellStr(cell);
    if (s) existing.set(s, idx);
    // Also match Chinese headers already written.
    const zh = cellStr(zhRow[idx]);
    if (zh) existing.set(zh, idx);
  });

  const colIndex = {};
  for (const f of fields) {
    if (existing.has(f.en)) {
      colIndex[f.key] = existing.get(f.en);
      continue;
    }
    if (existing.has(f.zh)) {
      colIndex[f.key] = existing.get(f.zh);
      continue;
    }
    const idx = keyRow.length;
    keyRow.push(f.en);
    while (zhRow.length < idx) zhRow.push("");
    zhRow[idx] = f.zh;
    if (typeRow) {
      while (typeRow.length < idx) typeRow.push("");
      const isStr =
        f.type === "string" || f.key === "simTier" || f.key === "simError";
      typeRow[idx] = isStr ? "string" : "number";
    }
    colIndex[f.key] = idx;
  }
  state.colIndex = colIndex;
  state.activeFields = fields;
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

function displayFields() {
  const fields = state.activeFields || activeResultFields();
  return fields.filter((f) => f.key !== "simError");
}

function renderTable() {
  if (!els.table) return;
  const cols = displayFields();
  const head = `
    <thead><tr>
      <th>行</th>
      <th>关卡号</th>
      <th>表索引</th>
      <th>状态</th>
      ${cols.map((f) => `<th>${f.zh}</th>`).join("")}
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
      const cells = cols
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
  for (const f of displayFields()) {
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
  const fields = state.activeFields || activeResultFields();
  for (const f of fields) {
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

async function runOneForkTier(level, tier, branches, onProgress) {
  const preset = SIM_OP_PRESETS[tier.id];
  if (!preset) throw new Error(`未知操作档：${tier.id}`);
  const report = await analyzeLevelOffMain(level, {
    mode: "fork",
    trials: branches,
    maxBranches: branches,
    maxForkWidth: 8,
    strategy: "greedy",
    maxMoves: 2500,
    seed: 42,
    chunkSize: 1,
    enabledOps: normalizeEnabledOps(preset.ops),
    slimResults: false,
    onProgress,
  });
  return forkLeafCounts(report);
}

async function runBatch() {
  if (state.running || !state.rows.length) return;
  syncBatchModeUi();
  ensureResultColumns();
  renderTable();

  const mode = readBatchMode();
  const trials = readTrials();
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
  const tierSteps = mode === "forkTiers" ? FORK_TIER_DEFS.length : 1;
  const workTotal = total * tierSteps;
  let workDone = 0;

  for (let i = 0; i < total; i += 1) {
    if (state.stop) break;
    const row = state.rows[i];
    if (!row.level) {
      row.status = "error";
      row.error = row.error || "无有效关卡数据";
      writeMetricsToAoa(row);
      updateRowDom(i);
      done += 1;
      workDone += tierSteps;
      continue;
    }

    row.status = "running";
    updateRowDom(i);

    try {
      if (mode === "forkTiers") {
        const metrics = { ...(row.metrics || {}) };
        for (let t = 0; t < FORK_TIER_DEFS.length; t += 1) {
          if (state.stop) break;
          const tier = FORK_TIER_DEFS[t];
          setStatus(
            `关卡 ${row.levelId}（${i + 1}/${total}）· ${tier.label}档分叉 ${trials} 支路（${t + 1}/3）…`,
          );
          const counts = await runOneForkTier(row.level, tier, trials, (p) => {
            if (state.stop) return;
            const levelPct = p.total ? Math.round((p.done / p.total) * 100) : 0;
            setStatus(
              `关卡 ${row.levelId}（${i + 1}/${total}）· ${tier.label} · 支路 ${p.done}/${p.total}（${levelPct}%）`,
            );
          });
          if (state.stop) break;
          metrics[`${tier.prefix}WinCount`] = counts.winCount;
          metrics[`${tier.prefix}FailCount`] = counts.failCount;
          metrics[`${tier.prefix}WinRate`] = counts.winRate;
          metrics[`${tier.prefix}WinEasyOpPct`] = counts.winEasyOpPct;
          metrics[`${tier.prefix}WinNormalOpPct`] = counts.winNormalOpPct;
          metrics[`${tier.prefix}WinHardOpPct`] = counts.winHardOpPct;
          row.metrics = { ...metrics };
          updateRowDom(i);
          workDone += 1;
          const elapsed = performance.now() - startedAt;
          const msPer = elapsed / Math.max(1, workDone);
          const eta = (workTotal - workDone) * msPer;
          const pctDone = Math.round((workDone / workTotal) * 1000) / 10;
          if (els.bar) els.bar.style.width = `${pctDone}%`;
          setStatus(
            `进度 ${workDone}/${workTotal} 档次（${pctDone}%）· 关卡 ${row.levelId} 已完成 ${tier.label} · 已用 ${formatDuration(elapsed)} · 预计剩余 ${formatDuration(eta)}`,
          );
        }
        if (state.stop) {
          row.status = "pending";
          updateRowDom(i);
          break;
        }
        row.metrics = metrics;
        row.status = "done";
        row.error = "";
      } else {
        setStatus(`正在模拟关卡 ${row.levelId}（${i + 1}/${total}）· 每关 ${trials} 局…`);
        const report = await analyzeLevelOffMain(row.level, {
          mode: "montecarlo",
          trials,
          strategy: "greedy",
          maxMoves: 2500,
          seed: 42,
          chunkSize: 2,
          enabledOps: readEnabledOpsFromUi(),
          slimResults: true,
          onProgress: (p) => {
            if (state.stop) return;
            const levelPct = p.total ? Math.round((p.done / p.total) * 100) : 0;
            setStatus(
              `关卡 ${row.levelId}（${i + 1}/${total}）· 局 ${p.done}/${p.total}（${levelPct}%）· 后台计算中…`,
            );
          },
        });
        if (state.stop) {
          row.status = "pending";
          updateRowDom(i);
          break;
        }
        row.metrics = metricsFromReport(report);
        row.status = "done";
        row.error = "";
        workDone += 1;
      }
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
      workDone = Math.min(workTotal, (i + 1) * tierSteps);
    }

    writeMetricsToAoa(row);
    updateRowDom(i);
    done += 1;

    if (mode !== "forkTiers") {
      const elapsed = performance.now() - startedAt;
      const msPer = elapsed / done;
      const eta = (total - done) * msPer;
      const pctDone = Math.round((done / total) * 1000) / 10;
      if (els.bar) els.bar.style.width = `${pctDone}%`;
      setStatus(
        `进度 ${done}/${total}（${pctDone}%）· 已用 ${formatDuration(elapsed)} · 预计剩余 ${formatDuration(eta)}`,
      );
    }
  }

  if (state.stop) terminateAnalyzeWorker();

  state.running = false;
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnDownload.disabled = false;

  if (state.stop) setStatus(`已停止：完成 ${done}/${total} 关。可下载当前结果。`);
  else if (mode === "forkTiers") {
    setStatus(
      `全部完成：${total} 关 × 3 档 × ${trials} 支路。已写回 9 列（胜利/失败/通关率）。点击「下载结果表」。`,
    );
  } else {
    setStatus(`全部完成：${total} 关 × ${trials} 局。点击「下载结果表」。`);
  }
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
  const drop = document.getElementById("batchDrop") || els.drop;
  const fileInput = document.getElementById("batchFile") || els.file;
  if (!drop && !fileInput) {
    console.error("[batch] 找不到上传区域 DOM");
    return;
  }
  if (drop) els.drop = drop;
  if (fileInput) els.file = fileInput;
  els.status = document.getElementById("batchStatus") || els.status;

  let lastFileKey = "";
  let lastFileAt = 0;

  const onFile = (file) => {
    if (!file) {
      setStatus("未读到文件内容，请再选一次或换用点击上传");
      return;
    }
    const name = file.name || "未命名.xlsx";
    const key = `${name}:${file.size}:${file.lastModified}`;
    const now = Date.now();
    if (key === lastFileKey && now - lastFileAt < 1500) return;
    lastFileKey = key;
    lastFileAt = now;

    setStatus(`读取 ${name}（${Math.max(1, Math.round(file.size / 1024))} KB）…`);
    parseFile(file).catch((err) => {
      setStatus(err.message || String(err));
      console.error(err);
    });
  };

  const isFileDrag = (e) => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    try {
      return (
        Array.from(types).includes("Files") ||
        Array.from(types).includes("application/x-moz-file") ||
        (typeof types.contains === "function" && types.contains("Files"))
      );
    } catch {
      return true;
    }
  };

  window.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });

  if (drop) {
    drop.addEventListener("dragenter", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      drop.classList.add("is-dragover");
    });
    drop.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      drop.classList.add("is-dragover");
    });
    drop.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && drop.contains(e.relatedTarget)) return;
      drop.classList.remove("is-dragover");
    });
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("is-dragover");
      onFile(e.dataTransfer?.files?.[0]);
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const input = e.target || fileInput;
      const list = input?.files;
      if (!list || !list.length) return;
      onFile(list[0]);
      setTimeout(() => {
        try {
          input.value = "";
        } catch {
          /* ignore */
        }
      }, 0);
    });
  }

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

  document.getElementById("batchMode")?.addEventListener("change", () => {
    syncBatchModeUi();
    if (state.aoa && state.layout) {
      ensureResultColumns();
      renderTable();
    }
  });

  window.__BATCH_BOUND__ = true;
  syncBatchModeUi();
  setStatus("等待上传表格…（上传组件已就绪）");
  loadXlsxLib()
    .then(() => {
      const cur = document.getElementById("batchStatus")?.textContent || "";
      if (cur.includes("上传组件已就绪") || cur.startsWith("等待上传表格")) {
        setStatus("等待上传表格…（可拖拽或点击上传）");
      }
    })
    .catch((err) => {
      setStatus(`Excel 解析库加载失败：${err.message || err}`);
    });
}

bindUi();
