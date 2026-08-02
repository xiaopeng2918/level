import {
  analyzeLevelAsync,
  playout,
  hydrateForkLeafTrace,
  classifyOpSkill,
  summarizeOpSkillMix,
  SIM_OP_DEFS,
  SIM_OP_PRESETS,
  defaultEnabledOps,
  normalizeEnabledOps,
} from "./analyze.js?v=20260803m";
import { analyzeLevelOffMain } from "./analyze-client.js?v=20260803m";

const TRIPLE_WIDTH = 3;
const SINGLE_WIDTH = 1;
const SPECIAL_CLEAR_ID = 999;
const FREEZE_SECONDS = 15;

const SAMPLE_LEVEL = [
  [
    [0, 18, 18],
    [38, 33, 0],
    [78, 78, 0],
    [138, 138, 0],
    [0, 0, 148],
    [204, 204, 183],
  ],
  [
    [10, 15, 15],
    [28, 63, 28],
    [33, 49, 76],
    [91, 91, 0],
    [181, 182, 145],
    [193, 0, 0],
  ],
  [
    [12, 0, 10],
    [44, 27, 44],
    [38, 61, 47],
    [124, 144, 138],
    [181, 145, 181],
    [198, 183, 186],
    [239, 999, 0],
  ],
  [
    [9, 21, 25],
    [17, 0, 33],
    [50, 50, 56],
    [0, 0, 81],
    [171, 0, 171],
    [182, 182, 204],
  ],
  [
    [12, 10, 12],
    [19, 56, 25],
    [0, 76, 0],
    [95, 95, 91],
    [0, 148, 0],
    [193, 193, 188],
  ],
  [
    [17, 15, 17],
    [0, 27, 44],
    [61, 50, 76],
    [0, 86, 86],
    [180, 171, 180],
    [192, 192, 186],
    [239, 0, 0],
  ],
  [
    [0, 0, 19],
    [0, 61, 38],
    [28, 47, 47],
    [144, 124, 81],
    [148, 0, 0],
    [188, 183, 192],
  ],
  [
    [3, 21, 3],
    [21, 0, 0],
    [63, 0, 63],
    [105, 0, 124],
    [0, 144, 0],
    [0, 198, 0],
  ],
  [
    [999, 0, 9],
    [25, 35, 27],
    [49, 49, 0],
    [95, 86, 81],
    [172, 0, 172],
    [0, 0, 198],
  ],
  [
    [3, 19, 0],
    [35, 35, 0],
    [0, 78, 999],
    [105, 105, 0],
    [180, 172, 145],
    [186, 188, 0],
    [0, 239, 0],
  ],
  [[9], [18], [56]],
];

const EMOJI_POOL = [
  "🍎", "🍌", "🍇", "🧁", "🍩", "🥛", "☕", "🥤", "🍞", "🧀",
  "🍪", "🍬", "🥕", "🌽", "🍓", "🍑", "🥝", "🍍", "🍅", "🧄",
  "🥨", "🍫", "🧃", "🍯", "🫐", "🍒", "🥥", "🍋", "🍊", "🍉",
  "🥑", "🌶️", "🥐", "🥯", "🥚", "🍗", "🍕", "🌮", "🍣", "🍤",
];

const SHAPE_POOL = ["round", "squircle", "tile", "chip", "hex"];

const COLOR_POOL = [
  "#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1",
  "#1e88e5", "#8e24aa", "#d81b60", "#6d4c41", "#37474f",
  "#00897b", "#7cb342", "#c0ca33", "#ff7043", "#5c6bc0",
  "#ec407a", "#26a69a", "#ab47bc", "#ef6c00", "#546e7a",
];

const visualCache = new Map();

function hashId(id) {
  let n = Math.abs(Number(id)) | 0;
  n = (n ^ 0x9e3779b9) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35) >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}

function isSpecialClearId(id) {
  return Number(id) === SPECIAL_CLEAR_ID;
}

function visualForId(id) {
  const key = String(id);
  if (visualCache.has(key)) return visualCache.get(key);

  if (isSpecialClearId(id)) {
    const visual = {
      emoji: "⭐",
      color: "#ffd54f",
      shape: "round",
      label: "999",
      special: true,
    };
    visualCache.set(key, visual);
    return visual;
  }

  const h = hashId(id);
  const visual = {
    emoji: EMOJI_POOL[h % EMOJI_POOL.length],
    color: COLOR_POOL[(h >>> 8) % COLOR_POOL.length],
    shape: SHAPE_POOL[(h >>> 16) % SHAPE_POOL.length],
    label: String(id),
    special: false,
  };
  visualCache.set(key, visual);
  return visual;
}

function paintItemElement(el, id, { peek = false } = {}) {
  const visual = visualForId(id);
  el.classList.add("filled", `shape-${visual.shape}`);
  if (visual.special) el.classList.add("special-clear");
  if (peek) el.classList.add("peek");
  el.style.setProperty("--item-color", visual.color);
  el.title = visual.special ? "ID 999：单击消除" : `ID ${id}`;
  el.innerHTML = `<span class="item-emoji">${visual.emoji}</span><span class="item-id">${visual.label}</span>`;
  return visual;
}

const els = {
  board: document.getElementById("board"),
  hint: document.getElementById("hint"),
  layerLabel: document.getElementById("layerLabel"),
  timerLabel: document.getElementById("timerLabel"),
  comboLabel: document.getElementById("comboLabel"),
  freezeCount: document.getElementById("freezeCount"),
  shuffleCount: document.getElementById("shuffleCount"),
  hammerCount: document.getElementById("hammerCount"),
  btnFreeze: document.getElementById("btnFreeze"),
  btnShuffle: document.getElementById("btnShuffle"),
  btnHammer: document.getElementById("btnHammer"),
  btnRestart: document.getElementById("btnRestart"),
  btnSample: document.getElementById("btnSample"),
  btnAnalyze: document.getElementById("btnAnalyze"),
  analyzeMode: document.getElementById("analyzeMode"),
  analyzeTrials: document.getElementById("analyzeTrials"),
  analyzeTrialsLabelText: document.getElementById("analyzeTrialsLabelText"),
  btnLoadLevel: document.getElementById("btnLoadLevel"),
  levelInput: document.getElementById("levelInput"),
  levelError: document.getElementById("levelError"),
  analyzeResult: document.getElementById("analyzeResult"),
  simOpsList: document.getElementById("simOpsList"),
  btnSimOpsAll: document.getElementById("btnSimOpsAll"),
  btnSimOpsNone: document.getElementById("btnSimOpsNone"),
  overlay: document.getElementById("overlay"),
  modalKicker: document.getElementById("modalKicker"),
  modalTitle: document.getElementById("modalTitle"),
  modalText: document.getElementById("modalText"),
  modalPrimary: document.getElementById("modalPrimary"),
  modalSecondary: document.getElementById("modalSecondary"),
  timerStat: document.querySelector(".timer-stat"),
};

const state = {
  sourceData: structuredClone(SAMPLE_LEVEL),
  shelves: [],
  selected: null, // { shelfIndex, slotIndex }
  timeLeft: 90,
  combo: 0,
  running: false,
  frozen: false,
  freezeUntil: 0,
  hammerMode: false,
  boosters: { freeze: 2, shuffle: 1, hammer: 1 },
  timerId: null,
  clearing: false,
  drag: null,
};

function setHint(text) {
  els.hint.textContent = text;
}

function setLevelError(message) {
  if (!message) {
    els.levelError.hidden = true;
    els.levelError.textContent = "";
    return;
  }
  els.levelError.hidden = false;
  els.levelError.textContent = message;
}

function normalizeLayer(layer) {
  if (!Array.isArray(layer) || (layer.length !== SINGLE_WIDTH && layer.length !== TRIPLE_WIDTH)) {
    throw new Error("每一层长度只能是 1 或 3");
  }
  return layer.map((cell) => {
    const value = Number(cell);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`非法物品 ID：${cell}`);
    }
    return value;
  });
}

function parseLevelData(raw) {
  let data = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) throw new Error("请先粘贴关卡数据");
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("JSON 解析失败，请检查括号和逗号");
    }
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("关卡必须是非空数组：[[[...]]]");
  }

  const shelves = data.map((shelf, shelfIndex) => {
    if (!Array.isArray(shelf) || shelf.length === 0) {
      throw new Error(`货架 ${shelfIndex} 至少要有 1 层`);
    }
    const layers = shelf.map((layer, layerIndex) => {
      try {
        return normalizeLayer(layer);
      } catch (error) {
        throw new Error(`货架 ${shelfIndex} 第 ${layerIndex} 层：${error.message}`);
      }
    });

    const width = layers[0].length;
    if (layers.some((layer) => layer.length !== width)) {
      throw new Error(`货架 ${shelfIndex} 各层宽度必须一致（同为 1 或同为 3）`);
    }

    return {
      layers,
      width,
      outputOnly: width === SINGLE_WIDTH,
    };
  });

  const counts = new Map();
  for (const shelf of shelves) {
    for (const layer of shelf.layers) {
      for (const id of layer) {
        if (id === 0 || isSpecialClearId(id)) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
  }
  const bad = [...counts.entries()].filter(([, count]) => count % 3 !== 0);
  const warning =
    bad.length > 0
      ? `警告：这些 ID 数量不是 3 的倍数，可能无法清关：${bad.map(([id, c]) => `${id}×${c}`).join("，")}`
      : "";

  return { shelves, warning, counts };
}

function cloneShelves(sourceShelves) {
  return sourceShelves.map((shelf) => ({
    width: shelf.width,
    outputOnly: shelf.outputOnly ?? shelf.width === SINGLE_WIDTH,
    layers: shelf.layers.map((layer) => [...layer]),
  }));
}

function estimateTime(shelves) {
  let items = 0;
  let layers = 0;
  for (const shelf of shelves) {
    layers += shelf.layers.length;
    for (const layer of shelf.layers) {
      items += layer.filter((id) => id !== 0).length;
    }
  }
  return Math.max(60, Math.round(items * 4.5 + layers * 3));
}

function frontLayer(shelf) {
  return shelf.layers[0] ?? null;
}

function shelfWidth(shelf) {
  return shelf.width ?? frontLayer(shelf)?.length ?? TRIPLE_WIDTH;
}

function isOutputOnlyShelf(shelf) {
  return Boolean(shelf.outputOnly || shelfWidth(shelf) === SINGLE_WIDTH);
}

function countLayers() {
  return state.shelves.reduce((sum, shelf) => sum + shelf.layers.length, 0);
}

function countItems() {
  return state.shelves.reduce((sum, shelf) => {
    return (
      sum +
      shelf.layers.reduce((layerSum, layer) => layerSum + layer.filter((id) => id !== 0).length, 0)
    );
  }, 0);
}

function isLayerEmpty(layer) {
  return layer.every((id) => id === 0);
}

function isLayerMatched(layer) {
  if (!layer || layer.length !== TRIPLE_WIDTH) return false;
  if (layer.some((id) => id === 0)) return false;
  if (isSpecialClearId(layer[0])) return false; // 999 only clears by click
  return layer.every((id) => id === layer[0]);
}

function firstEmptySlot(layer) {
  return layer.findIndex((id) => id === 0);
}

function pruneShelf(shelf) {
  while (shelf.layers.length > 0 && isLayerEmpty(shelf.layers[0])) {
    shelf.layers.shift();
  }
}

function canPlaceOnShelf(shelfIndex) {
  const shelf = state.shelves[shelfIndex];
  if (!shelf || isOutputOnlyShelf(shelf)) return false;
  if (shelf.layers.length === 0) return true;
  return firstEmptySlot(shelf.layers[0]) !== -1;
}

function updateHud() {
  els.layerLabel.textContent = String(countLayers());
  els.timerLabel.textContent = String(Math.max(0, Math.ceil(state.timeLeft)));
  els.comboLabel.textContent = String(state.combo);
  els.freezeCount.textContent = String(state.boosters.freeze);
  els.shuffleCount.textContent = String(state.boosters.shuffle);
  els.hammerCount.textContent = String(state.boosters.hammer);

  els.timerStat.classList.toggle("urgent", state.timeLeft <= 10 && state.running);
  els.timerStat.classList.toggle("frozen", state.frozen);

  els.btnFreeze.disabled = !state.running || state.boosters.freeze <= 0 || state.frozen;
  els.btnShuffle.disabled = !state.running || state.boosters.shuffle <= 0 || state.clearing;
  els.btnHammer.disabled = !state.running || state.boosters.hammer <= 0 || state.clearing;
  els.btnHammer.classList.toggle("active-tool", state.hammerMode);
}

function render() {
  els.board.innerHTML = "";

  const selectedShelf = state.selected?.shelfIndex ?? state.drag?.fromShelf ?? null;
  const hoverTarget = state.drag?.hover?.shelfIndex ?? null;
  const hoverSlot = state.drag?.hover?.slotIndex ?? null;

  state.shelves.forEach((shelf, shelfIndex) => {
    const shelfEl = document.createElement("div");
    shelfEl.className = `shelf width-${shelfWidth(shelf)}`;
    if (isOutputOnlyShelf(shelf)) shelfEl.classList.add("output-only");
    shelfEl.dataset.shelfIndex = String(shelfIndex);

    if (selectedShelf === shelfIndex) shelfEl.classList.add("selected-source");

    const layerPreview = frontLayer(shelf);
    const hasReceivableEmpty =
      canPlaceOnShelf(shelfIndex) &&
      (!layerPreview ||
        layerPreview.some(
          (id, slot) =>
            id === 0 &&
            !(selectedShelf === shelfIndex && state.selected?.slotIndex === slot) &&
            !(state.drag?.fromShelf === shelfIndex && state.drag?.fromSlot === slot),
        ));
    if (selectedShelf !== null && hasReceivableEmpty) {
      shelfEl.classList.add("valid-target");
    }
    if (hoverTarget === shelfIndex) {
      const slotOk =
        canPlaceOnShelf(shelfIndex) &&
        hoverSlot != null &&
        layerPreview?.[hoverSlot] === 0 &&
        !(state.drag?.fromShelf === shelfIndex && state.drag?.fromSlot === hoverSlot);
      shelfEl.classList.add(slotOk ? "drop-ok" : "drop-bad");
    }

    const depth = document.createElement("div");
    depth.className = "shelf-depth";
    const widthTag = shelfWidth(shelf) === SINGLE_WIDTH ? "单格·只出" : "三格";
    depth.textContent =
      shelf.layers.length > 1
        ? `${widthTag} +${shelf.layers.length - 1}`
        : shelf.layers.length === 0
          ? `${widthTag}·空`
          : widthTag;
    shelfEl.appendChild(depth);

    // Show peek of next layer behind.
    if (shelf.layers.length > 1) {
      const peek = document.createElement("div");
      peek.className = "layer peek-layer";
      shelf.layers[1].forEach((id) => {
        const cell = document.createElement("div");
        cell.className = "item";
        if (id === 0) {
          cell.classList.add("empty");
        } else {
          paintItemElement(cell, id, { peek: true });
        }
        peek.appendChild(cell);
      });
      shelfEl.appendChild(peek);
    }

    const front = document.createElement("div");
    front.className = "layer front-layer";

    const layer = frontLayer(shelf);
    const slots = layer ?? Array(shelfWidth(shelf)).fill(0);

    slots.forEach((id, slotIndex) => {
      const cell = document.createElement("div");
      cell.className = "item";
      cell.dataset.slotIndex = String(slotIndex);

      if (!layer) {
        cell.classList.add("empty", "placeholder");
      } else if (id === 0) {
        cell.classList.add("empty");
        if (
          hoverTarget === shelfIndex &&
          hoverSlot === slotIndex &&
          canPlaceOnShelf(shelfIndex) &&
          !(state.drag?.fromShelf === shelfIndex && state.drag?.fromSlot === slotIndex)
        ) {
          cell.classList.add("drop-slot");
        }
        if (state.running && !state.clearing && canPlaceOnShelf(shelfIndex)) {
          cell.addEventListener("click", (event) => {
            event.stopPropagation();
            onEmptySlotClick(shelfIndex, slotIndex);
          });
        }
      } else {
        paintItemElement(cell, id);
        cell.classList.add("movable");
        if (isSpecialClearId(id)) cell.classList.add("special-clear");

        const active =
          (state.selected?.shelfIndex === shelfIndex && state.selected?.slotIndex === slotIndex) ||
          (state.drag?.fromShelf === shelfIndex && state.drag?.fromSlot === slotIndex);
        if (active) cell.classList.add("selected");
        if (state.drag?.fromShelf === shelfIndex && state.drag?.fromSlot === slotIndex) {
          cell.classList.add("dragging-source");
        }

        if (state.running && !state.clearing) {
          cell.style.touchAction = "none";
          if (!isSpecialClearId(id)) {
            cell.addEventListener("pointerdown", (event) => onItemPointerDown(event, shelfIndex, slotIndex));
          }
          cell.addEventListener("click", (event) => {
            event.stopPropagation();
            onItemClick(shelfIndex, slotIndex);
          });
        }
      }

      front.appendChild(cell);
    });

    shelfEl.appendChild(front);
    shelfEl.addEventListener("click", () => onShelfClick(shelfIndex));
    els.board.appendChild(shelfEl);
  });

  updateHud();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearMatchedFronts() {
  const matchedIndexes = [];
  state.shelves.forEach((shelf, index) => {
    const layer = frontLayer(shelf);
    if (layer && isLayerMatched(layer)) matchedIndexes.push(index);
  });

  if (!matchedIndexes.length) return false;

  state.clearing = true;
  matchedIndexes.forEach((index) => {
    const shelfEl = els.board.children[index];
    shelfEl?.querySelectorAll(".front-layer .item.movable").forEach((el) => el.classList.add("clearing"));
  });
  await wait(280);

  for (const index of matchedIndexes) {
    state.shelves[index].layers.shift();
  }

  state.combo += matchedIndexes.length;
  state.clearing = false;
  setHint(state.combo > 1 ? `连消 x${state.combo}！` : "三消成功");
  render();
  return true;
}

function compactEmptyFronts() {
  let changed = false;
  for (const shelf of state.shelves) {
    const before = shelf.layers.length;
    pruneShelf(shelf);
    if (shelf.layers.length !== before) changed = true;
  }
  return changed;
}

async function afterMove() {
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const cleared = await clearMatchedFronts();
    const compacted = compactEmptyFronts();
    if (compacted) render();
    if (!cleared && !compacted) break;
  }

  if (countItems() === 0) {
    winLevel();
    return;
  }

  if (isBoardFailed()) {
    loseLevel({
      reason: "deadlock",
      title: "陷入死局",
      text: "已翻开的首层凑不出三消（也没有 999），且空位不够把任何一层整层搬走翻新，本关失败。",
    });
  }
}

/** 首层当前就能消，或仅凭已翻开的首层物品就有望凑成三消 */
function canEliminateOnFront() {
  const visibleCounts = new Map();

  for (const shelf of state.shelves) {
    const layer = frontLayer(shelf);
    if (!layer) continue;
    if (isLayerMatched(layer)) return true;
    for (const id of layer) {
      if (id === 0) continue;
      if (isSpecialClearId(id)) return true; // 999 单击可消
      visibleCounts.set(id, (visibleCounts.get(id) || 0) + 1);
    }
  }

  // 已翻开的首层里，某颜色至少 3 个 → 仍可能靠挪位凑消
  for (const count of visibleCounts.values()) {
    if (count >= 3) return true;
  }
  return false;
}

/** 某个货架最外层上的非空物品数量 */
function frontItemCount(shelf) {
  const layer = frontLayer(shelf);
  if (!layer) return 0;
  return layer.filter((id) => id !== 0).length;
}

/**
 * 统计「可作为移入目标」的空位数（仅三格、可接收的货架最外层）。
 * excludeShelf：正在被掏空的来源货架，其空位不能用来承接自己移出的物品以完成「整层清空」的计数。
 */
function countReceivableEmptySlots(excludeShelfIndex = -1) {
  let empty = 0;
  state.shelves.forEach((shelf, index) => {
    if (index === excludeShelfIndex) return;
    if (isOutputOnlyShelf(shelf)) return;

    const layer = frontLayer(shelf);
    if (!layer) {
      // 已空的三格货架，整层可重新放入 width 个
      empty += shelfWidth(shelf) || TRIPLE_WIDTH;
      return;
    }
    empty += layer.filter((id) => id === 0).length;
  });
  return empty;
}

/**
 * 能否通过把某货架最外层物品全部挪到其他空位，从而暴露新层。
 * （下层可以没有物品；关键是当前层被搬空。）
 */
function canExposeNewLayer() {
  return state.shelves.some((shelf, index) => {
    const items = frontItemCount(shelf);
    if (items <= 0) return false;
    // 没有后层时，搬空只是清掉该架，也算「暴露/翻开」后的空层推进；
    // 按你的定义：只要能把当前层搬空即可。
    return countReceivableEmptySlots(index) >= items;
  });
}

/**
 * 失败：首层没法消，且没法再搬空任何一层来翻新层。
 * 注意：不一定是所有三格都塞满——空位不够搬空任何一整层也会死。
 */
function isBoardFailed() {
  if (countItems() === 0) return false;
  if (canEliminateOnFront()) return false;
  if (canExposeNewLayer()) return false;
  return true;
}

async function tryMove(fromShelf, fromSlot, toShelf, toSlot = null) {
  const source = state.shelves[fromShelf];
  const target = state.shelves[toShelf];
  const sourceLayer = frontLayer(source);
  if (!source || !target || !sourceLayer) return false;

  const itemId = sourceLayer[fromSlot];
  if (!itemId) return false;
  if (isSpecialClearId(itemId)) {
    setHint("999 请直接单击消除，不用拖拽");
    return false;
  }

  if (isOutputOnlyShelf(target)) {
    setHint("单格货架只能移出，不能移入");
    return false;
  }

  if (target.layers.length === 0) {
    target.layers.push(Array(TRIPLE_WIDTH).fill(0));
    target.width = TRIPLE_WIDTH;
    target.outputOnly = false;
  }

  const targetLayer = frontLayer(target);
  if (!targetLayer || targetLayer.length !== TRIPLE_WIDTH) {
    setHint("只能放到三格货架上");
    return false;
  }

  let destSlot = toSlot;
  if (destSlot == null || destSlot < 0 || destSlot >= targetLayer.length) {
    destSlot = firstEmptySlot(targetLayer);
  }

  if (destSlot === -1 || destSlot == null) {
    setHint("目标位置没有空位");
    return false;
  }

  if (fromShelf === toShelf && fromSlot === destSlot) return false;

  if (targetLayer[destSlot] !== 0) {
    if (fromShelf !== toShelf) {
      destSlot = firstEmptySlot(targetLayer);
      if (destSlot === -1) {
        setHint("目标货架最外层没有空位");
        return false;
      }
    } else {
      setHint("同货架只能拖到空位");
      return false;
    }
  }

  sourceLayer[fromSlot] = 0;
  targetLayer[destSlot] = itemId;
  pruneShelf(source);

  state.selected = null;
  setHint(fromShelf === toShelf ? "已在同货架换位" : "物品已移动");
  render();
  await afterMove();
  return true;
}

function highlightDropTargets(fromShelf, fromSlot, hover) {
  const hoverShelf = hover?.shelfIndex ?? null;
  const hoverSlot = hover?.slotIndex ?? null;

  els.board.querySelectorAll(".shelf").forEach((shelfEl) => {
    const index = Number(shelfEl.dataset.shelfIndex);
    const shelf = state.shelves[index];
    const layer = frontLayer(shelf);
    const canReceive = canPlaceOnShelf(index);

    shelfEl.classList.toggle("selected-source", index === fromShelf);
    shelfEl.classList.toggle("valid-target", canReceive);
    shelfEl.classList.toggle(
      "drop-ok",
      canReceive &&
        hoverShelf === index &&
        hoverSlot != null &&
        layer?.[hoverSlot] === 0 &&
        !(index === fromShelf && hoverSlot === fromSlot),
    );
    shelfEl.classList.toggle(
      "drop-bad",
      hoverShelf === index &&
        (!canReceive ||
          hoverSlot == null ||
          (layer && layer[hoverSlot] !== 0) ||
          (index === fromShelf && hoverSlot === fromSlot)),
    );

    shelfEl.querySelectorAll(".front-layer .item").forEach((itemEl) => {
      const slotIndex = Number(itemEl.dataset.slotIndex);
      const active = index === fromShelf && slotIndex === fromSlot;
      const isDropSlot =
        canReceive &&
        hoverShelf === index &&
        hoverSlot === slotIndex &&
        layer?.[slotIndex] === 0 &&
        !(index === fromShelf && slotIndex === fromSlot);
      itemEl.classList.toggle("dragging-source", active);
      itemEl.classList.toggle("selected", active);
      itemEl.classList.toggle("drop-slot", isDropSlot);
    });
  });
}

function dropTargetFromPoint(x, y) {
  // Temporarily ignore drag ghost for hit-testing.
  const ghost = state.drag?.ghost;
  if (ghost) ghost.style.pointerEvents = "none";

  const el = document.elementFromPoint(x, y);
  const slotEl = el?.closest?.(".front-layer .item");
  const shelfEl = el?.closest?.(".shelf");

  if (!shelfEl) return null;

  const shelfIndex = Number(shelfEl.dataset.shelfIndex);
  if (!Number.isInteger(shelfIndex)) return null;

  if (slotEl && shelfEl.contains(slotEl)) {
    const slotIndex = Number(slotEl.dataset.slotIndex);
    if (Number.isInteger(slotIndex)) {
      return { shelfIndex, slotIndex };
    }
  }

  // Hovering shelf chrome / gap: pick nearest front-slot by X.
  const layer = frontLayer(state.shelves[shelfIndex]);
  if (!layer) return { shelfIndex, slotIndex: 0 };

  const slots = [...shelfEl.querySelectorAll(".front-layer .item")];
  if (!slots.length) return { shelfIndex, slotIndex: firstEmptySlot(layer) };

  let best = null;
  let bestDist = Infinity;
  slots.forEach((slotNode) => {
    const rect = slotNode.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    const slotIndex = Number(slotNode.dataset.slotIndex);
    if (dist < bestDist && Number.isInteger(slotIndex)) {
      bestDist = dist;
      best = slotIndex;
    }
  });

  return { shelfIndex, slotIndex: best };
}

function createDragGhost(visual, x, y) {
  const ghost = document.createElement("div");
  ghost.className = `drag-ghost shape-${visual.shape}`;
  ghost.style.setProperty("--item-color", visual.color);
  ghost.innerHTML = `<span class="item-emoji">${visual.emoji}</span><span class="item-id">${visual.label}</span>`;
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
  document.body.appendChild(ghost);
  return ghost;
}

function clearDrag() {
  state.drag?.ghost?.remove();
  state.drag = null;
  document.body.classList.remove("is-dragging");
  els.board.querySelectorAll(".drop-slot").forEach((el) => el.classList.remove("drop-slot"));
}

function onItemPointerDown(event, shelfIndex, slotIndex) {
  if (!state.running || state.clearing || state.hammerMode) return;
  if (event.button != null && event.button !== 0) return;

  const layer = frontLayer(state.shelves[shelfIndex]);
  const itemId = layer?.[slotIndex];
  if (!itemId) return;

  event.preventDefault();
  event.stopPropagation();

  const visual = visualForId(itemId);
  state.selected = null;
  state.drag = {
    fromShelf: shelfIndex,
    fromSlot: slotIndex,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    hover: null,
    ghost: null,
    visual,
  };

  document.body.classList.add("is-dragging");
  highlightDropTargets(shelfIndex, slotIndex, null);

  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // ignore
  }

  const onMove = (moveEvent) => {
    if (!state.drag || moveEvent.pointerId !== state.drag.pointerId) return;
    const dx = moveEvent.clientX - state.drag.startX;
    const dy = moveEvent.clientY - state.drag.startY;

    if (!state.drag.moved && Math.hypot(dx, dy) > 6) {
      state.drag.moved = true;
      state.drag.ghost = createDragGhost(state.drag.visual, moveEvent.clientX, moveEvent.clientY);
      setHint("拖到目标空位后松手（同货架也可以）");
    }

    if (!state.drag.moved) return;
    state.drag.ghost.style.left = `${moveEvent.clientX}px`;
    state.drag.ghost.style.top = `${moveEvent.clientY}px`;

    const hover = dropTargetFromPoint(moveEvent.clientX, moveEvent.clientY);
    const same =
      hover?.shelfIndex === state.drag.hover?.shelfIndex &&
      hover?.slotIndex === state.drag.hover?.slotIndex;
    if (!same) {
      state.drag.hover = hover;
      highlightDropTargets(state.drag.fromShelf, state.drag.fromSlot, hover);
    }
  };

  const onUp = async (upEvent) => {
    if (!state.drag || upEvent.pointerId !== state.drag.pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);

    const { fromShelf, fromSlot, moved } = state.drag;
    const drop = dropTargetFromPoint(upEvent.clientX, upEvent.clientY);
    clearDrag();

    if (!moved) {
      state.selected = { shelfIndex: fromShelf, slotIndex: fromSlot };
      setHint("已选中物品，拖到空位或点击空位");
      render();
      return;
    }

    if (!drop) {
      setHint("已取消拖拽");
      render();
      return;
    }

    await tryMove(fromShelf, fromSlot, drop.shelfIndex, drop.slotIndex);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

async function clearSpecialAt(shelfIndex, slotIndex) {
  const shelf = state.shelves[shelfIndex];
  const layer = frontLayer(shelf);
  if (!layer || !isSpecialClearId(layer[slotIndex])) return false;

  layer[slotIndex] = 0;
  pruneShelf(shelf);
  state.selected = null;
  state.combo += 1;
  setHint("999 已单击消除");
  render();
  await afterMove();
  return true;
}

async function onItemClick(shelfIndex, slotIndex) {
  if (!state.running || state.clearing || state.drag) return;

  const layer = frontLayer(state.shelves[shelfIndex]);
  const itemId = layer?.[slotIndex];

  if (!itemId) {
    if (state.selected) {
      await tryMove(state.selected.shelfIndex, state.selected.slotIndex, shelfIndex, slotIndex);
    }
    return;
  }

  if (isSpecialClearId(itemId) && !state.hammerMode) {
    await clearSpecialAt(shelfIndex, slotIndex);
    return;
  }

  if (state.hammerMode) {
    layer[slotIndex] = 0;
    pruneShelf(state.shelves[shelfIndex]);
    state.boosters.hammer -= 1;
    state.hammerMode = false;
    state.selected = null;
    state.combo = 0;
    setHint("锤子砸掉了一个物品");
    render();
    await afterMove();
    return;
  }

  if (state.selected?.shelfIndex === shelfIndex && state.selected?.slotIndex === slotIndex) {
    state.selected = null;
    setHint("已取消选择");
    render();
    return;
  }

  if (state.selected) {
    const targetLayer = frontLayer(state.shelves[shelfIndex]);
    if (targetLayer?.[slotIndex] === 0) {
      await tryMove(state.selected.shelfIndex, state.selected.slotIndex, shelfIndex, slotIndex);
      return;
    }
  }

  state.selected = { shelfIndex, slotIndex };
  setHint("已选中物品，拖到三格货架的空位或点击空位");
  render();
}

async function onEmptySlotClick(shelfIndex, slotIndex) {
  if (!state.running || state.clearing || state.drag || state.hammerMode) return;
  if (!state.selected) return;
  await tryMove(state.selected.shelfIndex, state.selected.slotIndex, shelfIndex, slotIndex);
}

async function onShelfClick(shelfIndex) {
  if (!state.running || state.clearing || state.drag || state.hammerMode) return;
  if (!state.selected) return;

  const shelf = state.shelves[shelfIndex];
  if (isOutputOnlyShelf(shelf)) {
    setHint("单格货架只能移出，不能移入");
    return;
  }

  if (shelf.layers.length === 0) {
    shelf.layers.push(Array(TRIPLE_WIDTH).fill(0));
    shelf.width = TRIPLE_WIDTH;
    shelf.outputOnly = false;
  }

  const layer = frontLayer(shelf);
  const dest = layer.findIndex(
    (id, slot) => id === 0 && !(shelfIndex === state.selected.shelfIndex && slot === state.selected.slotIndex),
  );
  if (dest === -1) {
    if (state.selected.shelfIndex === shelfIndex) {
      state.selected = null;
      setHint("已取消选择");
      render();
    } else {
      setHint("该货架没有空位");
    }
    return;
  }
  await tryMove(state.selected.shelfIndex, state.selected.slotIndex, shelfIndex, dest);
}

function tick() {
  if (!state.running) return;
  const now = performance.now();
  if (state.frozen) {
    if (now >= state.freezeUntil) {
      state.frozen = false;
      setHint("冻结结束，时间继续走");
    }
    updateHud();
    return;
  }

  state.timeLeft -= 0.25;
  updateHud();
  if (state.timeLeft <= 0) {
    state.timeLeft = 0;
    loseLevel();
  }
}

function startTimer() {
  stopTimer();
  state.timerId = setInterval(tick, 250);
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

function showModal({ kicker, title, text, primary, secondary, onPrimary, onSecondary }) {
  els.modalKicker.textContent = kicker;
  els.modalTitle.textContent = title;
  els.modalText.textContent = text;
  els.modalPrimary.textContent = primary;
  els.modalPrimary.onclick = onPrimary;

  if (secondary) {
    els.modalSecondary.classList.remove("hidden");
    els.modalSecondary.textContent = secondary;
    els.modalSecondary.onclick = onSecondary;
  } else {
    els.modalSecondary.classList.add("hidden");
    els.modalSecondary.onclick = null;
  }

  els.overlay.classList.remove("hidden");
}

function hideModal() {
  els.overlay.classList.add("hidden");
}

function startLevel({ resetBoosters = false, keepTime = false } = {}) {
  const parsed = parseLevelData(state.sourceData);
  state.shelves = cloneShelves(parsed.shelves);
  if (!keepTime) state.timeLeft = estimateTime(state.shelves);
  state.selected = null;
  state.combo = 0;
  state.running = true;
  state.frozen = false;
  state.freezeUntil = 0;
  state.hammerMode = false;
  state.clearing = false;
  clearDrag();

  if (resetBoosters) state.boosters = { freeze: 2, shuffle: 1, hammer: 1 };

  hideModal();
  setHint("三格可拖放凑消；单格只出不进；⭐999 单击即消");
  render();
  startTimer();

  if (isBoardFailed()) {
    loseLevel({
      reason: "deadlock",
      title: "陷入死局",
      text: "已翻开的首层凑不出三消（也没有 999），且空位不够把任何一层整层搬走翻新，本关失败。",
    });
  }
}

function winLevel() {
  state.running = false;
  stopTimer();
  showModal({
    kicker: "过关",
    title: "货架清空了",
    text: "可以在下方输入框粘贴新的关卡数据继续玩。",
    primary: "再玩本关",
    secondary: "加载示例关卡",
    onPrimary: () => startLevel({ resetBoosters: true }),
    onSecondary: () => {
      fillSample();
      loadFromInput({ autoStart: true });
    },
  });
}

function loseLevel({
  reason = "timeout",
  title = "没有在时限内清完",
  text = "可以重开，或调整关卡数据后再加载。",
} = {}) {
  if (!state.running) return;
  state.running = false;
  stopTimer();
  showModal({
    kicker: reason === "deadlock" ? "死局" : "时间到",
    title,
    text,
    primary: "再试一次",
    secondary: "填入示例",
    onPrimary: () => startLevel({ resetBoosters: true }),
    onSecondary: () => {
      fillSample();
      loadFromInput({ autoStart: true });
    },
  });
}

function useFreeze() {
  if (!state.running || state.boosters.freeze <= 0 || state.frozen) return;
  state.boosters.freeze -= 1;
  state.frozen = true;
  state.freezeUntil = performance.now() + FREEZE_SECONDS * 1000;
  setHint(`时间冻结 ${FREEZE_SECONDS} 秒`);
  updateHud();
}

function useShuffle() {
  if (!state.running || state.boosters.shuffle <= 0 || state.clearing) return;

  const ids = [];
  for (const shelf of state.shelves) {
    const layer = frontLayer(shelf);
    if (!layer) continue;
    for (let i = 0; i < layer.length; i += 1) {
      if (layer[i] !== 0) {
        ids.push(layer[i]);
        layer[i] = 0;
      }
    }
    pruneShelf(shelf);
  }

  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  const placeable = state.shelves.filter((shelf) => !isOutputOnlyShelf(shelf));
  let cursor = 0;

  for (const shelf of placeable) {
    if (!frontLayer(shelf) && cursor < ids.length) {
      shelf.layers.unshift(Array(TRIPLE_WIDTH).fill(0));
      shelf.width = TRIPLE_WIDTH;
      shelf.outputOnly = false;
    }
    const layer = frontLayer(shelf);
    if (!layer) continue;
    for (let i = 0; i < layer.length && cursor < ids.length; i += 1) {
      if (layer[i] === 0) {
        layer[i] = ids[cursor];
        cursor += 1;
      }
    }
  }

  while (cursor < ids.length) {
    let placed = false;
    for (const shelf of placeable) {
      if (!frontLayer(shelf)) {
        shelf.layers.unshift(Array(TRIPLE_WIDTH).fill(0));
        shelf.width = TRIPLE_WIDTH;
        shelf.outputOnly = false;
      }
      const layer = frontLayer(shelf);
      const empty = firstEmptySlot(layer);
      if (empty !== -1) {
        layer[empty] = ids[cursor];
        cursor += 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      placeable[0].layers.unshift([ids[cursor], 0, 0]);
      cursor += 1;
    }
  }

  state.boosters.shuffle -= 1;
  state.selected = null;
  state.hammerMode = false;
  setHint("最外层已重排（单格货架不接收物品）");
  render();
  afterMove();
}

function useHammer() {
  if (!state.running || state.boosters.hammer <= 0 || state.clearing) return;
  state.hammerMode = !state.hammerMode;
  state.selected = null;
  setHint(state.hammerMode ? "锤子模式：点最外层任意物品砸掉" : "已取消锤子");
  render();
}

function fillSample() {
  els.levelInput.value = JSON.stringify(SAMPLE_LEVEL, null, 0);
  setLevelError("");
}

function loadFromInput({ autoStart = false } = {}) {
  try {
    const parsed = parseLevelData(els.levelInput.value);
    state.sourceData = parsed.shelves.map((shelf) => shelf.layers.map((layer) => [...layer]));
    setLevelError(parsed.warning || "");

    if (autoStart || state.running || !els.overlay.classList.contains("hidden")) {
      startLevel({ resetBoosters: true });
    } else {
      state.shelves = cloneShelves(parsed.shelves);
      state.timeLeft = estimateTime(state.shelves);
      render();
      setHint("关卡已解析，点击开始游戏");
    }

    if (parsed.warning) setHint(parsed.warning);
  } catch (error) {
    setLevelError(error.message || "关卡数据无效");
  }
}

els.btnFreeze.addEventListener("click", useFreeze);
els.btnShuffle.addEventListener("click", useShuffle);
els.btnHammer.addEventListener("click", useHammer);
els.btnRestart.addEventListener("click", () => startLevel({ resetBoosters: false }));
function pct(n) {
  return `${Math.round(n * 1000) / 10}%`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} 秒`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  if (min < 60) return `${min} 分 ${rem} 秒`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr} 小时 ${remMin} 分`;
}

const RESULT_LABEL = {
  win: "通关",
  deadlock: "卡死",
  limit: "步数上限",
};

const SIM_OPS_STORAGE_KEY = "goods-sort-sim-ops-v1";

function loadStoredEnabledOps() {
  try {
    const raw = localStorage.getItem(SIM_OPS_STORAGE_KEY);
    if (!raw) return defaultEnabledOps();
    return normalizeEnabledOps(JSON.parse(raw));
  } catch {
    return defaultEnabledOps();
  }
}

function saveEnabledOps(ops) {
  try {
    localStorage.setItem(SIM_OPS_STORAGE_KEY, JSON.stringify(ops));
  } catch {
    /* ignore quota */
  }
}

function readEnabledOpsFromUi() {
  if (!els.simOpsList) return defaultEnabledOps();
  const ops = defaultEnabledOps();
  els.simOpsList.querySelectorAll('input[data-sim-op]').forEach((input) => {
    ops[input.dataset.simOp] = input.checked;
  });
  return normalizeEnabledOps(ops);
}

function renderSimOpsPanel() {
  if (!els.simOpsList) return;
  const enabled = loadStoredEnabledOps();
  els.simOpsList.innerHTML = SIM_OP_DEFS.map(
    (op) => `<label class="sim-op-item">
      <input type="checkbox" data-sim-op="${op.id}" ${enabled[op.id] ? "checked" : ""} />
      <span class="sim-op-label">${op.label}</span>
      <span class="sim-op-scene">${op.scene}</span>
      <span class="sim-op-score"><strong>分值</strong> ${op.score}</span>
    </label>`,
  ).join("");
  syncSimOpsPresetButtons();
}

function setAllSimOps(checked) {
  if (!els.simOpsList) return;
  els.simOpsList.querySelectorAll('input[data-sim-op]').forEach((input) => {
    input.checked = checked;
  });
  saveEnabledOps(readEnabledOpsFromUi());
  syncSimOpsPresetButtons();
}

function applySimOpsPreset(presetId) {
  const preset = SIM_OP_PRESETS[presetId];
  if (!preset || !els.simOpsList) return;
  const ops = normalizeEnabledOps(preset.ops);
  els.simOpsList.querySelectorAll('input[data-sim-op]').forEach((input) => {
    input.checked = Boolean(ops[input.dataset.simOp]);
  });
  saveEnabledOps(ops);
  syncSimOpsPresetButtons(presetId);
}

function matchSimOpsPresetId(ops) {
  const normalized = normalizeEnabledOps(ops);
  for (const [id, preset] of Object.entries(SIM_OP_PRESETS)) {
    const want = normalizeEnabledOps(preset.ops);
    const same = SIM_OP_DEFS.every((op) => Boolean(want[op.id]) === Boolean(normalized[op.id]));
    if (same) return id;
  }
  return null;
}

function syncSimOpsPresetButtons(forcedId) {
  const activeId = forcedId ?? matchSimOpsPresetId(readEnabledOpsFromUi());
  document.querySelectorAll(".sim-ops-preset-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.opsPreset === activeId);
  });
}

function enabledOpsSummary(ops) {
  const presetId = matchSimOpsPresetId(ops);
  if (presetId && SIM_OP_PRESETS[presetId]) {
    return `操作水平·${SIM_OP_PRESETS[presetId].label}`;
  }
  const on = SIM_OP_DEFS.filter((op) => ops[op.id]).map((op) => op.label);
  if (on.length === SIM_OP_DEFS.length) return "全部操作";
  if (!on.length) return "无操作";
  return on.join("、");
}

const REASON_LABEL = {
  special: "点999",
  match3: "凑三",
  setup3: "首层多步凑三",
  setupReveal: "选架翻层",
  pair: "凑对",
  digMatch: "翻层可消",
  digReveal: "多步翻层",
  digLayer: "露出下层",
  dig: "翻非末层",
  single: "清单格",
  move: "普通搬",
  random: "随机",
  fallback: "次选",
};

const TRIAL_PAGE_SIZE = 40;

const analyzeSession = {
  raw: "",
  report: null,
  filter: "all",
  page: 0,
  selectedIndex: null,
  /** @type {Array<{before:any,after:any}>|null} */
  traceBoards: null,
};

function readAnalyzeMode() {
  return els.analyzeMode?.value === "fork" ? "fork" : "montecarlo";
}

function syncAnalyzeModeUi() {
  const fork = readAnalyzeMode() === "fork";
  if (els.analyzeTrialsLabelText) {
    els.analyzeTrialsLabelText.textContent = fork ? "最大支路数" : "模拟局数";
  }
  if (els.analyzeTrials) {
    els.analyzeTrials.min = fork ? "1" : "10";
    els.analyzeTrials.max = fork ? "100000" : "50000";
    els.analyzeTrials.step = fork ? "1" : "10";
    // 只做范围钳制，不要把自定义值打回默认 64/120（开跑前也会走这里）。
    const n = Number(els.analyzeTrials.value);
    if (Number.isFinite(n)) {
      els.analyzeTrials.value = String(
        fork
          ? Math.min(100000, Math.max(1, Math.round(n)))
          : Math.min(50000, Math.max(10, Math.round(n))),
      );
    }
  }
}

function readAnalyzeTrials() {
  const fork = readAnalyzeMode() === "fork";
  const raw = Number(els.analyzeTrials?.value);
  if (!Number.isFinite(raw)) return fork ? 64 : 120;
  if (fork) return Math.min(100000, Math.max(1, Math.round(raw)));
  return Math.min(50000, Math.max(10, Math.round(raw)));
}

function isForkReport(report = analyzeSession.report) {
  return report?.config?.mode === "fork" || report?.summary?.forkMode === true;
}

function renderAnalyzeProgress({ done, total, elapsedMs, etaMs, msPerTrial }) {
  const fork = readAnalyzeMode() === "fork";
  const unit = fork ? "支路" : "局";
  const pctDone = total ? Math.round((done / total) * 1000) / 10 : 0;
  const etaText =
    done < 3
      ? "预估中…"
      : `预计剩余 ${formatDuration(etaMs)}（约 ${msPerTrial.toFixed(0)} 毫秒/${unit}）`;

  els.analyzeResult.innerHTML = `
    <div class="analyze-progress">
      <p>${fork ? `分叉中：最多 ${total} 条支路 · 贪心同分全展开` : `模拟中：贪心 × ${total} 局 · 仅移动`}</p>
      <div class="analyze-progress-bar" aria-hidden="true">
        <span style="width:${pctDone}%"></span>
      </div>
      <p class="analyze-progress-meta">
        已完成 <strong>${done}</strong> / ${total}（${pctDone}%） ·
        已用 ${formatDuration(elapsedMs)} · ${etaText}
      </p>
    </div>
  `;
}

function filteredTrials() {
  const results = analyzeSession.report?.results || [];
  if (analyzeSession.filter === "all") return results;
  return results.filter((r) => r.result === analyzeSession.filter);
}

/** @returns {{ step: number, choice: number, width: number, key: string }[]} */
function parseForkSegments(forkPath) {
  if (!forkPath || forkPath === "主路") return [];
  return String(forkPath)
    .split(/\s*→\s*/)
    .map((raw) => {
      const m = raw.trim().match(/^L(\d+)#(\d+)\/(\d+)$/);
      if (!m) return { step: 0, choice: 0, width: 0, key: raw.trim() };
      return {
        step: Number(m[1]),
        choice: Number(m[2]),
        width: Number(m[3]),
        key: raw.trim(),
      };
    })
    .filter((s) => s.key);
}

/**
 * Build a prefix tree from branch forkPath segments.
 * @returns {{ children: Map<string, any>, leaves: any[], segment: null }}
 */
function buildForkTree(results) {
  const root = { children: new Map(), leaves: [], segment: null };
  for (const r of results) {
    const segs = parseForkSegments(r.forkPath);
    let node = root;
    for (const seg of segs) {
      if (!node.children.has(seg.key)) {
        node.children.set(seg.key, { segment: seg, children: new Map(), leaves: [] });
      }
      node = node.children.get(seg.key);
    }
    node.leaves.push(r);
  }
  return root;
}

function forkLeafMeta(r) {
  const death =
    r.result === "win"
      ? "通关"
      : r.deathStep != null
        ? `死于逻辑步 ${r.deathStep}`
        : "未通关";
  return { death, fullPath: r.forkPath && r.forkPath !== "主路" ? r.forkPath : "主路（无同分分叉）" };
}

/** Stable key so shared prefixes across branches merge into one node. */
function forkTraceStepKey(step) {
  if (step?.action && typeof step.action === "object") {
    try {
      return JSON.stringify(step.action);
    } catch {
      /* fall through */
    }
  }
  return `${step?.step ?? "?"}|${step?.text || step?.reason || ""}`;
}

/**
 * Build diagram from full per-branch traces: every logic step is a node.
 * kind: root | step (unique best) | fork (score-tie split) | leaf
 */
function buildStepDiagramFromResults(results) {
  let seq = 0;
  const root = {
    id: "root",
    kind: "root",
    label: "开局",
    sub: "逐步",
    title: "开局",
    edgeLabel: "",
    isFork: false,
    children: [],
    childMap: new Map(),
  };

  for (const r of results) {
    const steps = Array.isArray(r.trace) ? r.trace : [];
    const forkByStep = new Map((r.forkPoints || []).map((p) => [p.step, p]));
    let parent = root;

    for (const step of steps) {
      const key = forkTraceStepKey(step);
      const fp = forkByStep.get(step.step);
      const isFork = Boolean(fp) || (step.forkWidth != null && step.forkWidth > 1);
      const width = fp?.candidates || step.forkWidth || 0;
      const choice = fp != null ? (fp.chosenIndex ?? 0) + 1 : null;
      const edgeLabel = isFork && choice != null && width > 0 ? `#${choice}/${width}` : "";

      if (!parent.childMap.has(key)) {
        const reason = REASON_LABEL[step.reason] || step.reason || "走子";
        const node = {
          id: `s-${seq++}`,
          kind: isFork ? "fork" : "step",
          label: `L${step.step}`,
          sub: isFork ? `分叉×${width || "?"}` : reason,
          title: `${isFork ? "【同分分叉】" : "【唯一最优】"}${step.text || reason}`,
          edgeLabel,
          step: step.step,
          isFork,
          children: [],
          childMap: new Map(),
        };
        parent.childMap.set(key, node);
        parent.children.push(node);
      }
      parent = parent.childMap.get(key);
    }

    const leafKey = `leaf:${r.trialIndex}`;
    if (!parent.childMap.has(leafKey)) {
      const { death, fullPath } = forkLeafMeta(r);
      const leaf = {
        id: `leaf-${seq++}`,
        kind: "leaf",
        trialIndex: r.trialIndex,
        branchId: r.branchId ?? r.trialIndex,
        result: r.result,
        label: `#${r.branchId ?? r.trialIndex}`,
        sub: death,
        title: `${RESULT_LABEL[r.result] || r.result} · ${fullPath}`,
        edgeLabel: "",
        isFork: false,
        children: [],
        childMap: new Map(),
      };
      parent.childMap.set(leafKey, leaf);
      parent.children.push(leaf);
    }
  }

  return root;
}

/**
 * Horizontal layout: leaf slots on Y, parents at mean of children.
 */
function layoutForkDiagram(rootDiag, selectedTrialIndex) {
  const H_GAP = 78;
  const V_GAP = 50;
  const PAD_X = 20;
  const PAD_Y = 24;
  const NODE_W = { root: 56, step: 64, fork: 72, leaf: 132 };
  const NODE_H = 40;

  let leafSlot = 0;
  const all = [];

  const place = (node, depth) => {
    node.depth = depth;
    node.w = NODE_W[node.kind] || 64;
    node.h = NODE_H;
    all.push(node);
    if (!node.children.length) {
      node.row = leafSlot++;
      return;
    }
    for (const c of node.children) place(c, depth + 1);
    node.row = node.children.reduce((s, c) => s + c.row, 0) / node.children.length;
  };
  place(rootDiag, 0);

  let maxDepth = 0;
  for (const n of all) {
    n.x = PAD_X + n.depth * H_GAP;
    n.y = PAD_Y + n.row * V_GAP;
    maxDepth = Math.max(maxDepth, n.depth);
  }

  const parentOf = new Map();
  for (const n of all) {
    for (const c of n.children) parentOf.set(c.id, n);
  }
  const selectedPath = new Set();
  if (selectedTrialIndex != null) {
    const leaf = all.find((n) => n.kind === "leaf" && n.trialIndex === selectedTrialIndex);
    let cur = leaf;
    while (cur) {
      selectedPath.add(cur.id);
      cur = parentOf.get(cur.id);
    }
  }

  const width = PAD_X * 2 + maxDepth * H_GAP + NODE_W.leaf;
  const height = PAD_Y * 2 + Math.max(1, leafSlot) * V_GAP;
  return { nodes: all, width, height, selectedPath, nodeH: NODE_H };
}

const SKILL_STRIP = {
  easy: { cls: "skill-easy", label: "简单" },
  normalExtra: { cls: "skill-normal", label: "普通" },
  hardExtra: { cls: "skill-hard", label: "困难" },
};

/**
 * Among simulated leaves, which fork steps were actually expanded ≥2 ways
 * (same path prefix, different choice). Key: `${prefix}|L${step}`.
 */
function buildActualForkedStepKeys(results) {
  const groups = new Map();
  for (const r of results || []) {
    const segs = parseForkSegments(r.forkPath);
    for (let i = 0; i < segs.length; i += 1) {
      const prefix = segs
        .slice(0, i)
        .map((s) => s.key)
        .join("→");
      const key = `${prefix}|L${segs[i].step}`;
      let set = groups.get(key);
      if (!set) {
        set = new Set();
        groups.set(key, set);
      }
      set.add(segs[i].choice);
    }
  }
  const out = new Set();
  for (const [key, set] of groups) {
    if (set.size > 1) out.add(key);
  }
  return out;
}

function actualForkKeyForStep(forkPath, step) {
  const segs = parseForkSegments(forkPath);
  const idx = segs.findIndex((s) => s.step === step);
  if (idx < 0) return null;
  const prefix = segs
    .slice(0, idx)
    .map((s) => s.key)
    .join("→");
  return `${prefix}|L${step}`;
}

/**
 * Strip fork markers:
 * - canFork: 同分可分叉（本步 forkWidth>1），不论结果里是否展开多路
 * - didFork: 结果集中同一前缀下实际≥2 种选择
 * Classes: is-fork-able / is-fork（已分叉优先，两者可同时带）
 */
function stripForkFlags(step, forkByStep, forkPath, actualForkKeys) {
  const fp = forkByStep?.get?.(step.step);
  const canFork = Boolean(fp) || (step.forkWidth != null && step.forkWidth > 1);
  const forkKey = actualForkKeyForStep(forkPath, step.step);
  const didFork = forkKey != null && actualForkKeys.has(forkKey);
  let cls = "";
  if (canFork) cls += " is-fork-able";
  if (didFork) cls += " is-fork";
  return { canFork, didFork, fp, cls };
}

function stripForkTip(step, skillLabel, reasonLabel, flags) {
  const { canFork, didFork, fp } = flags;
  const choice =
    fp != null ? ` #${(fp.chosenIndex ?? 0) + 1}/${fp.candidates || step.forkWidth || "?"}` : "";
  if (didFork && canFork) {
    return `L${step.step} ${skillLabel} · 可分叉且已模拟分叉${choice} · ${reasonLabel}`;
  }
  if (didFork) {
    return `L${step.step} ${skillLabel} · 已模拟分叉${choice} · ${reasonLabel}`;
  }
  if (canFork) {
    return `L${step.step} ${skillLabel} · 可分叉（结果未展开多路）${choice} · ${reasonLabel}`;
  }
  return `L${step.step} ${skillLabel} · ${reasonLabel}`;
}

/** One cell per logic step for the open branch (aligned with the step list). */
function renderBranchSkillStripHtml(steps, enabledOps, summary = null) {
  const list = steps || [];
  if (!list.length) return "";
  const actualForkKeys = buildActualForkedStepKeys(analyzeSession.report?.results || []);
  const forkByStep = new Map((summary?.forkPoints || []).map((p) => [p.step, p]));
  const cells = list
    .map((step) => {
      const flags = stripForkFlags(step, forkByStep, summary?.forkPath, actualForkKeys);
      const skill = classifyOpSkill(step.reason, step.parts, enabledOps);
      const skillMeta = SKILL_STRIP[skill] || { cls: "skill-other", label: "其它" };
      const reasonLabel = REASON_LABEL[step.reason] || step.reason || "";
      const tip = stripForkTip(step, skillMeta.label, reasonLabel, flags);
      return `<span class="fork-strip-cell branch-strip-cell ${skillMeta.cls}${
        flags.cls
      }" title="${escapeHtml(tip)}"></span>`;
    })
    .join("");
  return `<div class="branch-skill-strip" title="与下方步骤一一对应">
    <span class="branch-skill-strip-label">本支路</span>
    <span class="branch-skill-strip-track">${cells}</span>
    <span class="branch-skill-strip-legend"><em class="c-easy">简单</em> <em class="c-normal">普通</em> <em class="c-hard">困难</em> · <em class="c-fork-able">黑虚边=可分叉</em> · <em class="c-fork">黑实边=已分叉</em></span>
  </div>`;
}

/**
 * Minimal strip overview: one row per branch, cells = logic steps.
 * Fill = 简单/普通/困难；虚边=可分叉；实粗边=结果里实际分叉过。
 */
function renderForkStripHtml(results) {
  const sorted = [...results].sort(
    (a, b) => (a.branchId ?? a.trialIndex) - (b.branchId ?? b.trialIndex),
  );
  const maxSteps = Math.max(1, ...sorted.map((r) => (r.trace || []).length));
  const selected = analyzeSession.selectedIndex;
  const enabledOps = normalizeEnabledOps(analyzeSession.report?.config?.enabledOps);
  const actualForkKeys = buildActualForkedStepKeys(sorted);

  const rows = sorted
    .map((r) => {
      const steps = r.trace || [];
      const forkByStep = new Map((r.forkPoints || []).map((p) => [p.step, p]));
      const active = selected === r.trialIndex ? " is-active" : "";
      const { death, fullPath } = forkLeafMeta(r);
      const cells = steps
        .map((step) => {
          const flags = stripForkFlags(step, forkByStep, r.forkPath, actualForkKeys);
          const skill = classifyOpSkill(step.reason, step.parts, enabledOps);
          const skillMeta = SKILL_STRIP[skill] || { cls: "skill-other", label: "其它" };
          const reasonLabel = REASON_LABEL[step.reason] || step.reason || "";
          const tip = stripForkTip(step, skillMeta.label, reasonLabel, flags);
          return `<span class="fork-strip-cell ${skillMeta.cls}${flags.cls}" title="${escapeHtml(tip)}"></span>`;
        })
        .join("");
      const pad =
        steps.length < maxSteps
          ? `<span class="fork-strip-pad" style="flex:${maxSteps - steps.length}"></span>`
          : "";
      return `<button type="button" class="fork-strip-row trial-row${active}" data-trial="${r.trialIndex}" title="${escapeHtml(fullPath)}">
        <span class="fork-strip-id">#${r.branchId ?? r.trialIndex}</span>
        <span class="fork-strip-track" style="--strip-steps:${maxSteps}">${cells}${pad}</span>
        <span class="fork-strip-end trial-result trial-${r.result}">${escapeHtml(death)}</span>
      </button>`;
    })
    .join("");

  return `<div class="fork-strip-wrap">
    <div class="fork-strip-head">
      <strong>支路缩略</strong>
      <span>一行一支路 · <em class="c-easy">简单</em> / <em class="c-normal">普通</em> / <em class="c-hard">困难</em> · <em class="c-fork-able">黑虚边=可分叉</em> · <em class="c-fork">黑实边=已分叉</em>（结果≥2路） · 点击行查看</span>
    </div>
    <div class="fork-strip-scroll">${rows}</div>
  </div>`;
}

/** SVG tree: every logic step; click leaf → green=非分叉, orange=分叉. */
function renderForkTreeHtml(results) {
  const diag = buildStepDiagramFromResults(results);
  const { nodes, width, height, selectedPath, nodeH } = layoutForkDiagram(
    diag,
    analyzeSession.selectedIndex,
  );
  const hasSelection = selectedPath.size > 0;

  const edges = [];
  for (const n of nodes) {
    for (const c of n.children) {
      const x1 = n.x + n.w;
      const y1 = n.y + nodeH / 2;
      const x2 = c.x;
      const y2 = c.y + nodeH / 2;
      const mid = (x1 + x2) / 2;
      const onPath = selectedPath.has(n.id) && selectedPath.has(c.id);
      const edgeKind =
        onPath && c.kind === "fork"
          ? " is-path is-path-fork"
          : onPath && (c.kind === "step" || c.kind === "leaf")
            ? " is-path is-path-step"
            : onPath
              ? " is-path"
              : hasSelection
                ? " is-dim"
                : "";
      const showEdgeLabel = Boolean(c.edgeLabel) && (onPath || !hasSelection);
      const label = showEdgeLabel
        ? `<text class="fork-diag-edge-label${onPath ? " is-path" : ""}" x="${mid}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle">${escapeHtml(c.edgeLabel)}</text>`
        : "";
      edges.push(
        `<path class="fork-diag-edge${edgeKind}" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" fill="none" />${label}`,
      );
    }
  }

  const nodeSvg = nodes
    .map((n) => {
      const onPath = selectedPath.has(n.id);
      const active = n.kind === "leaf" && n.trialIndex === analyzeSession.selectedIndex;
      const dim = hasSelection && !onPath ? " is-dim" : "";
      const cls = `fork-diag-node fork-diag-${n.kind}${onPath ? " is-path" : ""}${active ? " is-active" : ""}${dim}${
        n.result ? ` fork-diag-res-${n.result}` : ""
      }`;
      const title = escapeHtml(n.title || n.label);
      if (n.kind === "leaf") {
        return `<g class="${cls}">
          <foreignObject x="${n.x}" y="${n.y}" width="${n.w}" height="${nodeH}">
            <div xmlns="http://www.w3.org/1999/xhtml" class="fork-diag-fo">
              <button type="button" class="trial-row trial-row-fork fork-diag-fo-btn${active ? " is-active" : ""}" data-trial="${n.trialIndex}" title="${title}">
                <span class="trial-id">${escapeHtml(n.label)}</span>
                <span class="trial-result trial-${n.result}">${escapeHtml(RESULT_LABEL[n.result] || n.result)}</span>
                <span class="fork-diag-fo-sub">${escapeHtml(n.sub || "")}</span>
              </button>
            </div>
          </foreignObject>
        </g>`;
      }
      const badge =
        onPath && n.kind === "fork"
          ? `<text class="fork-diag-badge" x="${n.x + n.w - 4}" y="${n.y + 10}" text-anchor="end">叉</text>`
          : onPath && n.kind === "step"
            ? `<text class="fork-diag-badge fork-diag-badge-step" x="${n.x + n.w - 4}" y="${n.y + 10}" text-anchor="end">唯</text>`
            : "";
      return `<g class="${cls}">
        <title>${title}</title>
        <rect class="fork-diag-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${nodeH}" rx="9" />
        <text class="fork-diag-label" x="${n.x + n.w / 2}" y="${n.y + 16}" text-anchor="middle">${escapeHtml(n.label)}</text>
        <text class="fork-diag-sub" x="${n.x + n.w / 2}" y="${n.y + 30}" text-anchor="middle">${escapeHtml(n.sub || "")}</text>
        ${badge}
      </g>`;
    })
    .join("");

  const pathNote = hasSelection
    ? `<span class="fork-diag-path-note">已选路径：<em class="c-step">绿=非分叉</em> · <em class="c-fork">橙=同分分叉</em></span>`
    : `<span class="fork-diag-path-note">点击右侧叶子：高亮整条路径并区分分叉/非分叉</span>`;

  return `<div class="fork-diag-wrap">
    ${renderForkStripHtml(results)}
    <div class="fork-diag-legend">
      <span><i class="fork-leg fork-leg-root"></i>开局</span>
      <span><i class="fork-leg fork-leg-step"></i>非分叉步（唯一最优）</span>
      <span><i class="fork-leg fork-leg-branch"></i>同分分叉步</span>
      <span><i class="fork-leg fork-leg-win"></i>通关</span>
      <span><i class="fork-leg fork-leg-dead"></i>卡死/上限</span>
      ${pathNote}
    </div>
    <div class="fork-diag-scroll">
      <svg class="fork-diag-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="逐步分叉树状图">
        <g class="fork-diag-edges">${edges.join("")}</g>
        <g class="fork-diag-nodes">${nodeSvg}</g>
      </svg>
    </div>
  </div>`;
}

function renderTrialListOnly() {
  const listEl = document.getElementById("trialList");
  const pagerEl = document.getElementById("trialPager");
  const countEl = document.getElementById("trialCount");
  if (!listEl || !pagerEl) return;

  const rows = filteredTrials();
  const fork = isForkReport();

  if (countEl) {
    const types = analyzeSession.report?.summary?.patternTypes;
    if (fork) {
      const trunc = analyzeSession.report?.summary?.truncated ? " · 已截断" : "";
      countEl.textContent = `共 ${rows.length} 条支路 · 缩略+树状图${trunc}`;
    } else {
      countEl.textContent =
        types != null
          ? `共 ${rows.length} 局 · ${types} 种独立路径`
          : `共 ${rows.length} 局`;
    }
  }

  if (fork) {
    listEl.classList.add("is-fork-tree");
    listEl.innerHTML = rows.length
      ? renderForkTreeHtml(rows)
      : `<p class="trial-empty">当前筛选下无支路</p>`;
    pagerEl.innerHTML = `<span class="fork-tree-pager-hint">上方缩略：青绿=简单 · 琥珀=普通 · 红=困难 · 黑虚边=可分叉 · 黑实边=已分叉（结果≥2路）。点缩略行或叶子看 trace</span>`;
    return;
  }

  listEl.classList.remove("is-fork-tree");
  const pages = Math.max(1, Math.ceil(rows.length / TRIAL_PAGE_SIZE));
  if (analyzeSession.page >= pages) analyzeSession.page = pages - 1;
  if (analyzeSession.page < 0) analyzeSession.page = 0;
  const start = analyzeSession.page * TRIAL_PAGE_SIZE;
  const slice = rows.slice(start, start + TRIAL_PAGE_SIZE);

  listEl.innerHTML = slice
    .map((r) => {
      const active = analyzeSession.selectedIndex === r.trialIndex ? " is-active" : "";
      const pattern =
        r.patternId != null
          ? `<span class="trial-pattern" title="相同路径枚举；同型 ${r.patternCount || 1} 局">型${r.patternId}${
              (r.patternCount || 1) > 1 ? `×${r.patternCount}` : ""
            }</span>`
          : "";
      return `<button type="button" class="trial-row${active}" data-trial="${r.trialIndex}">
        <span class="trial-id">#${r.trialIndex}</span>
        ${pattern}
        <span class="trial-result trial-${r.result}">${RESULT_LABEL[r.result] || r.result}</span>
        <span>${r.moves} 步</span>
        <span>进度 ${pct(r.progress)}</span>
      </button>`;
    })
    .join("");

  pagerEl.innerHTML = `
    <button type="button" class="ghost-btn trial-page-btn" data-dir="-1" ${analyzeSession.page <= 0 ? "disabled" : ""}>上一页</button>
    <span>${analyzeSession.page + 1} / ${pages}</span>
    <button type="button" class="ghost-btn trial-page-btn" data-dir="1" ${analyzeSession.page >= pages - 1 ? "disabled" : ""}>下一页</button>
  `;
}

function renderAnalyzeReport(report) {
  const s = report.summary;
  const p = report.profile;
  const fork = isForkReport(report);
  const sampleUnit = fork ? "支路" : "局";
  const buckets = report.progressBuckets
    .map((b) => `<li><strong>${b.label}</strong>：${b.count} ${sampleUnit}（${pct(b.rate)}）</li>`)
    .join("");
  const meta = fork
    ? `贪心 · 单局分叉 · ${report.results?.length ?? 0}/${report.config.maxBranches ?? report.config.trials} 支路${
        s.truncated ? "（已截断）" : ""
      } · 宽≤${report.config.maxForkWidth ?? 8} · ${enabledOpsSummary(normalizeEnabledOps(report.config.enabledOps))}`
    : `贪心 · ${report.config.trials} 局 · 仅移动 · ${enabledOpsSummary(normalizeEnabledOps(report.config.enabledOps))}`;
  const fullBranchLine =
    fork && s.fullBranchCount != null
      ? `<li title="${escapeHtml(s.fullBranchNote || "")}">完整分叉宇宙 <strong>${
          s.fullBranchExact ? s.fullBranchCount : `> ${s.fullBranchCount}`
        }</strong>${s.fullBranchExact ? " 条" : "（已截断，未穷尽测算）"}</li>`
      : "";
  const rateNote = fork
    ? `<p class="analyze-profile">分叉支路样本比例（非蒙特卡洛局数）${
        s.truncated ? "；同分宽度或支路上限导致截断" : ""
      }</p>`
    : "";

  els.analyzeResult.innerHTML = `
    <div class="analyze-head">
      <strong>难度 ${s.difficulty}</strong>
      <span class="analyze-tier">${s.tier}</span>
      <span class="analyze-meta">${meta}</span>
    </div>
    <ul class="analyze-stats">
      <li>通关率 <strong>${pct(s.winRate)}</strong></li>
      <li>卡死率 <strong>${pct(s.deadlockRate)}</strong></li>
      <li>步数上限耗尽 <strong>${pct(s.limitRate)}</strong></li>
      <li>卡死时平均进度 <strong>${pct(s.avgDeadlockProgress)}</strong></li>
      <li>半程前卡死 <strong>${pct(s.earlyStuckRate)}</strong></li>
        <li>通关中位步数 <strong>${s.p50WinMoves || "—"}</strong>（P90 ${s.p90WinMoves || "—"}，按实际移动）</li>
      ${fullBranchLine}
      ${
        fork && s.winOpMix && s.winOpMix.total
          ? `<li title="${escapeHtml(s.winOpMixNote || "")}">胜利支路操作占比 · 简单 <strong>${s.winOpMix.easyPct}%</strong> · 普通多出 <strong>${s.winOpMix.normalExtraPct}%</strong> · 困难多出 <strong>${s.winOpMix.hardExtraPct}%</strong>（共 ${s.winOpMix.total} 步）</li>`
          : ""
      }
    </ul>
    <p class="analyze-profile">结构：${p.shelves} 架 / ${p.items} 物 / ${p.types} 种 / 深 ${p.maxDepth} / 特殊 ${p.specials}</p>
    ${rateNote}
    <ul class="analyze-buckets">${buckets}</ul>

    <div class="trial-browser">
      <div class="trial-browser-head">
        <strong>${fork ? "支路明细" : "单局明细"}</strong>
        <span id="trialCount"></span>
      </div>
      <div class="trial-filters">
        <label>筛选
          <select id="trialFilter">
            <option value="all">全部</option>
            <option value="win">通关</option>
            <option value="deadlock">卡死</option>
            <option value="limit">步数上限</option>
          </select>
        </label>
      </div>
      <div id="trialList" class="trial-list"></div>
      <div id="trialPager" class="trial-pager"></div>
      <div id="trialDetail" class="trial-detail" hidden></div>
    </div>
  `;

  const filterEl = document.getElementById("trialFilter");
  if (filterEl) filterEl.value = analyzeSession.filter;
  renderTrialListOnly();
  const listEl = document.getElementById("trialList");
  if (listEl && !(report.results || []).length) {
    listEl.innerHTML = `<p class="trial-empty">暂无单局数据。请硬刷新页面后重新分析。</p>`;
  }
}

function renderTraceDetail(summary, traced) {
  const detailEl = document.getElementById("trialDetail");
  if (!detailEl) return;

  const steps = traced.trace || [];
  const enabledOps = normalizeEnabledOps(analyzeSession.report?.config?.enabledOps);
  const forkPointSteps = new Set((summary.forkPoints || []).map((p) => p.step));
  analyzeSession.traceBoards = steps.map((step) => ({
    before: step.before,
    after: step.after,
  }));
  const stepHtml = steps
    .map((step, stepIndex) => {
      const top = (step.top || [])
        .map(
          (c) =>
            `<li class="${c.selected ? "is-picked" : ""}">${c.selected ? "→ " : ""}${c.text} · 分 ${c.score} · ${REASON_LABEL[c.reason] || c.reason}</li>`,
        )
        .join("");
      const warn = step.wasPreferred ? "" : '<span class="trial-warn">非首选(避环)</span>';
      const forkTag =
        (step.forkWidth > 1 || forkPointSteps.has(step.step))
          ? `<span class="trace-fork-tag">同分分叉 ×${step.forkWidth || summary.forkPoints?.find((p) => p.step === step.step)?.candidates || "?"}</span>`
          : "";
      const skill = classifyOpSkill(step.reason, step.parts, enabledOps);
      const skillMeta = SKILL_STRIP[skill] || { cls: "skill-other", label: "其它" };
      const skillTag = `<span class="trace-skill ${skillMeta.cls}">${skillMeta.label}</span>`;
      const atomicTag =
        step.atomicCount > 1
          ? `<span class="trace-atomic">实际 ${step.atomicCount} 手 · 累计移动 ${step.movesTotal}</span>`
          : `<span class="trace-atomic">实际 1 手 · 累计移动 ${step.movesTotal ?? step.step}</span>`;
      const submoves = (step.submoves || [])
        .map((m) => `<li>${m.i}. ${m.text}</li>`)
        .join("");
      const subBlock = submoves
        ? `<div class="trace-submoves"><p>子步骤（计入通关步数）：</p><ol>${submoves}</ol></div>`
        : "";
      const boards = renderTraceMoveBoards(step, stepIndex);
      return `<details class="trace-step">
        <summary>
          <span>#${step.step}</span>
          ${skillTag}
          <span class="trace-reason">${REASON_LABEL[step.reason] || step.reason}</span>
          <span>分 ${step.score}</span>
          <span>${
            step.action?.type === "plan"
              ? step.action.planKind === "dig"
                ? step.action.canMatchPrior && step.action.matchIds?.length
                  ? `翻层可消 id${step.action.matchIds.join(",")}`
                  : `多步翻层 露出id${(step.action.revealTypes || []).join(",") || "?"}`
                : `消除 id${step.action.matchType}`
              : step.text
          }</span>
          <span>进度 ${pct(step.progress)}</span>
          <span class="trace-reveal${step.revealScarce ? " is-scarce" : ""}" title="暴露机会=⌊空位/3⌋+首层可消组数">
            暴露 ${
              step.revealChancesBefore != null && step.revealChancesBefore !== step.revealChances
                ? `${step.revealChancesBefore}→${step.revealChances}`
                : (step.revealChances ?? "—")
            }${step.revealScarce ? "·稀缺" : ""}
          </span>
          ${atomicTag}
          ${forkTag}
          ${warn}
        </summary>
        <div class="trace-body">
          ${boards}
          ${subBlock}
          <p>候选 ${step.candidates} · ${step.parts.join("，") || "—"}</p>
          <p>同分/Top 候选：</p>
          <ol>${top || "<li>—</li>"}</ol>
        </div>
      </details>`;
    })
    .join("");

  const fork = summary.forkPath != null || isForkReport();
  const deathLine =
    fork && traced.result !== "win" && summary.deathStep != null
      ? ` · 死于逻辑步 ${summary.deathStep}`
      : fork && traced.result === "win"
        ? " · 通关"
        : "";
  detailEl.hidden = false;
  detailEl.innerHTML = `
    <div class="trial-detail-head">
      <strong>${fork ? `支路 #${summary.branchId ?? summary.trialIndex}` : `局 #${summary.trialIndex}`}</strong>
      ${
        !fork && summary.patternId != null
          ? `<span class="trial-pattern">型${summary.patternId}${
              (summary.patternCount || 1) > 1 ? `×${summary.patternCount}` : ""
            }</span>`
          : ""
      }
      <span class="trial-result trial-${traced.result}">${RESULT_LABEL[traced.result]}</span>
      <span>${traced.moves} 实际移动 · ${traced.logicSteps ?? traced.trace?.length ?? "—"} 逻辑步 · 进度 ${pct(traced.progress)}${
        fork ? deathLine : ` · seed ${traced.seed}`
      }</span>
    </div>
    ${
      fork
        ? `<p class="trial-detail-hint">路径：${escapeHtml(summary.forkPath || "主路")}。点击列表直接展示该支路已存 trace（非 seed 重跑）。「同分分叉 ×N」标出途经的最高分并列步。</p>`
        : `<p class="trial-detail-hint">「型N」按逐步着法路径指纹枚举，路径相同则共用同一型号。「暴露」为该步前后剩余暴露新层机会（⌊空位/3⌋+首层可消组数；≤2 且仍有下层时为稀缺）。展示按逻辑步；合成一步按实际移动手数累计。红=移出，绿=放入。可用「复制」导出前两层三维数组。</p>`
    }
    ${
      fork && summary.opMix && summary.opMix.total
        ? `<p class="trial-detail-hint">本支路操作占比（逻辑步）：简单 <strong>${summary.opMix.easyPct}%</strong>（${summary.opMix.easyCount}）· 普通多出 <strong>${summary.opMix.normalExtraPct}%</strong>（${summary.opMix.normalExtraCount}）· 困难多出 <strong>${summary.opMix.hardExtraPct}%</strong>（${summary.opMix.hardExtraCount}）</p>`
        : ""
    }
    ${fork ? renderBranchSkillStripHtml(steps, enabledOps, summary) : ""}
    <div class="trace-list">${stepHtml || "<p>无步骤记录</p>"}</div>
  `;
  detailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTraceCell(id, mark, phase = "before") {
  // 手数角标只标在「移动前」：起点红、落点绿，同一手同一数字。移动后不标数字。
  let badge = "";
  if (phase === "before" && typeof mark === "string") {
    const handMatch = mark.match(/is-hand-(\d+)/);
    if (handMatch) {
      const role =
        mark.includes("is-dst-target") || mark.includes("is-dst")
          ? "mini-hand-dst"
          : "mini-hand-src";
      badge = `<span class="mini-hand ${role}" title="第 ${handMatch[1]} 手">${handMatch[1]}</span>`;
    }
  }
  if (!id) {
    return `<span class="mini-cell empty${mark ? ` ${mark}` : ""}">${badge}</span>`;
  }
  const visual = visualForId(id);
  const special = visual.special ? " special" : "";
  return `<span class="mini-cell filled${special}${mark ? ` ${mark}` : ""}" style="--item-color:${visual.color}" title="ID ${id}">
    <span class="mini-emoji">${visual.emoji}</span>
    <span class="mini-id">${visual.label}</span>
    ${badge}
  </span>`;
}

/** Normalize highlight: single move, or all cells touched by a multi-hand plan. */
function normalizeHighlight(step) {
  const action = step?.action;
  if (action?.type === "plan" && Array.isArray(action.moves) && action.moves.length) {
    const touches = [];
    action.moves.forEach((m, idx) => {
      const hand = idx + 1;
      if (m.type === "special") {
        touches.push({ hand, kind: "special", shelf: m.shelf, slot: m.slot, id: 999 });
        return;
      }
      if (m.type === "move") {
        touches.push({
          hand,
          kind: "from",
          shelf: m.fromShelf,
          slot: m.fromSlot,
          id: m.id,
        });
        touches.push({
          hand,
          kind: "to",
          shelf: m.toShelf,
          slot: m.toSlot,
          id: m.id,
        });
      }
    });
    return { mode: "plan", touches, matchType: action.matchType };
  }
  return { mode: "single", highlight: step?.highlight || null };
}

function cellMark(hl, phase, shelfIndex, slotIndex, cellId) {
  if (!hl) return "";

  if (hl.mode === "plan") {
    const classes = [];
    for (const t of hl.touches) {
      if (t.shelf !== shelfIndex || t.slot !== slotIndex) continue;
      if (phase === "before") {
        if (t.kind === "from" || t.kind === "special") {
          classes.push("is-src", `is-hand-${t.hand}`);
        } else if (t.kind === "to") {
          classes.push("is-dst-target", `is-hand-${t.hand}`);
        }
      } else if (phase === "after") {
        if (t.kind === "to") {
          classes.push(cellId === t.id ? "is-dst" : "is-resolved", `is-hand-${t.hand}`);
        } else if (t.kind === "from") {
          classes.push("is-vacated", `is-hand-${t.hand}`);
        } else if (t.kind === "special") {
          classes.push("is-gone", `is-hand-${t.hand}`);
        }
      }
    }
    return [...new Set(classes)].join(" ");
  }

  const highlight = hl.highlight;
  if (!highlight) return "";
  // 单手与多手计划一致：前后用同一手数编号（固定为 1）。
  if (highlight.type === "special") {
    if (highlight.shelf === shelfIndex && highlight.slot === slotIndex) {
      return phase === "before" ? "is-src is-hand-1" : "is-gone is-hand-1";
    }
    return "";
  }
  if (phase === "before") {
    if (highlight.fromShelf === shelfIndex && highlight.fromSlot === slotIndex) {
      return "is-src is-hand-1";
    }
    if (highlight.toShelf === shelfIndex && highlight.toSlot === slotIndex) {
      return "is-dst-target is-hand-1";
    }
    return "";
  }
  if (phase === "after" && highlight.toShelf === shelfIndex && highlight.toSlot === slotIndex) {
    if (cellId === highlight.id) return "is-dst is-hand-1";
    return "is-resolved is-hand-1";
  }
  if (phase === "after" && highlight.fromShelf === shelfIndex && highlight.fromSlot === slotIndex) {
    return "is-vacated is-hand-1";
  }
  return "";
}

function shelfInvolved(hl, shelfIndex) {
  if (!hl) return false;
  if (hl.mode === "plan") {
    return hl.touches.some((t) => t.shelf === shelfIndex);
  }
  const highlight = hl.highlight;
  if (!highlight) return false;
  if (highlight.type === "special") return highlight.shelf === shelfIndex;
  return highlight.fromShelf === shelfIndex || highlight.toShelf === shelfIndex;
}

function renderMiniBoard(board, hl, phase) {
  if (!board?.length) return `<p class="mini-board-empty">无局面</p>`;
  const shelves = board
    .map((shelf) => {
      const involved = shelfInvolved(hl, shelf.i) ? " is-focus" : "";
      const layers =
        Array.isArray(shelf.layers) && shelf.layers.length
          ? shelf.layers
          : [shelf.front?.length ? shelf.front : Array.from({ length: shelf.w || 3 }, () => 0)];
      const front = layers[0] || Array.from({ length: shelf.w || 3 }, () => 0);
      const nextLayer = layers[1];
      const hasNext =
        Array.isArray(nextLayer) && nextLayer.some((id) => id !== 0);

      const layerCount = layers.length;
      const behindLabel = hasNext
        ? `<span class="mini-behind" title="剩余 ${layerCount} 层">${layerCount}层</span>`
        : '<span class="mini-behind is-last">末层</span>';

      const frontCells = front
        .map((id, slot) =>
          renderTraceCell(id, cellMark(hl, phase, shelf.i, slot, id), phase),
        )
        .join("");

      const peekRow = hasNext
        ? `<div class="mini-row mini-peek" title="剩余 ${layerCount} 层">${nextLayer
            .map((id) => renderTraceCell(id, "is-peek", phase))
            .join("")}</div>`
        : "";

      return `<div class="mini-shelf${involved} width-${shelf.w || 3}">
        <div class="mini-shelf-meta"><span>#${shelf.i}</span>${behindLabel}</div>
        <div class="mini-stack">
          <div class="mini-row mini-front">${frontCells}</div>
          ${peekRow}
        </div>
      </div>`;
    })
    .join("");
  return `<div class="mini-board">${shelves}</div>`;
}

/** Count every cell in the top `maxLayers` layers across all shelves (includes empty=0). */
function countTopLayerItems(board, maxLayers = 2) {
  const counts = new Map();
  const depth = Math.max(1, maxLayers);
  for (const shelf of board || []) {
    const layers =
      Array.isArray(shelf.layers) && shelf.layers.length
        ? shelf.layers
        : [Array.isArray(shelf.front) ? shelf.front : []];
    for (let li = 0; li < Math.min(depth, layers.length); li += 1) {
      const layer = layers[li];
      if (!Array.isArray(layer)) continue;
      for (const id of layer) {
        const key = Number(id) || 0;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

function renderLayerCountSummary(board, title, maxLayers) {
  const counts = countTopLayerItems(board, maxLayers);
  const entries = [...counts.entries()].sort((a, b) => {
    // Empty (0) always first; other ids by count desc, then id asc.
    if (a[0] === 0) return -1;
    if (b[0] === 0) return 1;
    return b[1] - a[1] || a[0] - b[0];
  });
  if (!entries.length) {
    return `<div class="layer-count-summary is-empty"><span class="layer-count-title">${title}</span><span>无</span></div>`;
  }
  const chips = entries
    .map(([id, n]) => {
      if (!id) {
        return `<span class="layer-count-chip is-empty" title="空格数量">空×${n}</span>`;
      }
      const visual = visualForId(id);
      return `<span class="layer-count-chip" style="--item-color:${visual.color}" title="ID ${id}">
        <span class="layer-count-emoji">${visual.emoji}</span>
        <span class="layer-count-id">${visual.label}</span>
        <span class="layer-count-n">×${n}</span>
      </span>`;
    })
    .join("");
  return `<div class="layer-count-summary"><span class="layer-count-title">${title}</span>${chips}</div>`;
}

function renderBoardLayerSummaries(board) {
  return `<div class="layer-count-block">
    ${renderLayerCountSummary(board, "第一层", 1)}
    ${renderLayerCountSummary(board, "前两层", 2)}
  </div>`;
}

function renderMoveCaption(hl, step) {
  if (hl?.mode === "plan" || step?.action?.type === "plan") {
    const hands = (step.action.moves || [])
      .map((m, i) => `${i + 1}.架${m.fromShelf ?? m.shelf}格${m.fromSlot ?? m.slot}→架${m.toShelf ?? "—"}格${m.toSlot ?? "—"}`)
      .join(" · ");
    if (step.action.planKind === "dig") {
      const canClear = step.action.canMatchPrior && step.action.matchIds?.length;
      const ids = canClear
        ? step.action.matchIds.join(",")
        : (step.action.revealTypes || []).join(",") || "?";
      const head = canClear ? `翻层可消 id${ids}` : `多步翻层 露出id${ids}`;
      return `<div class="move-caption">${head} · ×${step.atomicCount}手 · 合成1逻辑步 · ${hands}</div>`;
    }
    return `<div class="move-caption">首层多步凑三 · 消除 id${step.action.matchType} · ×${step.atomicCount}手 · 合成1逻辑步 · ${hands}</div>`;
  }
  const highlight = hl?.highlight;
  if (!highlight) return "";
  if (highlight.type === "special") {
    return `<div class="move-caption">清除 ⭐999 · 架${highlight.shelf} 格${highlight.slot}</div>`;
  }
  const visual = visualForId(highlight.id);
  const cleared =
    step?.after &&
    (() => {
      const shelf = step.after[highlight.toShelf];
      const cell = shelf?.front?.[highlight.toSlot];
      return cell !== highlight.id;
    })();
  return `<div class="move-caption"><span class="move-chip" style="--item-color:${visual.color}"><span>${visual.emoji}</span><span>${visual.label}</span></span> 架${highlight.fromShelf}·格${highlight.fromSlot} → 架${highlight.toShelf}·格${highlight.toSlot}${cleared ? " · 落入后消除/翻层" : ""}</div>`;
}

/**
 * Export displayed board (at most first + second layer) as level 3D array:
 * [ shelf[ layer[ id, ... ], ... ], ... ]
 */
function boardToTopTwoLevelArray(board) {
  return (board || []).map((shelf) => {
    const width = shelf.w || shelf.front?.length || 3;
    const layers =
      Array.isArray(shelf.layers) && shelf.layers.length
        ? shelf.layers
        : [Array.isArray(shelf.front) ? shelf.front : Array.from({ length: width }, () => 0)];
    const out = [];
    for (let i = 0; i < Math.min(2, layers.length); i += 1) {
      const layer = layers[i];
      out.push(Array.isArray(layer) ? layer.map((id) => Number(id) || 0) : Array.from({ length: width }, () => 0));
    }
    if (!out.length) out.push(Array.from({ length: width }, () => 0));
    return out;
  });
}

async function copyBoardTopTwoLayers(stepIndex, phase, buttonEl) {
  const entry = analyzeSession.traceBoards?.[stepIndex];
  const board = phase === "after" ? entry?.after : entry?.before;
  if (!board) {
    setLevelError("没有可复制的局面数据");
    return;
  }
  const text = JSON.stringify(boardToTopTwoLevelArray(board));
  try {
    await navigator.clipboard.writeText(text);
    if (buttonEl) {
      const prev = buttonEl.textContent;
      buttonEl.textContent = "已复制";
      buttonEl.disabled = true;
      setTimeout(() => {
        buttonEl.textContent = prev;
        buttonEl.disabled = false;
      }, 1200);
    }
  } catch (err) {
    setLevelError(`复制失败：${err?.message || err}`);
  }
}

function renderTraceMoveBoards(step, stepIndex) {
  const hl = normalizeHighlight(step);
  return `<div class="trace-boards">
    <div class="trace-board-pane">
      <div class="trace-board-label">
        <span>移动前</span>
        <button type="button" class="ghost-btn mini-copy-btn" data-copy-step="${stepIndex}" data-copy-phase="before" title="复制前两层为三维数组">复制</button>
      </div>
      ${renderMiniBoard(step.before, hl, "before")}
      ${renderBoardLayerSummaries(step.before)}
    </div>
    <div class="trace-board-mid">
      ${renderMoveCaption(hl, step)}
    </div>
    <div class="trace-board-pane">
      <div class="trace-board-label">
        <span>移动后</span>
        <button type="button" class="ghost-btn mini-copy-btn" data-copy-step="${stepIndex}" data-copy-phase="after" title="复制前两层为三维数组">复制</button>
      </div>
      ${renderMiniBoard(step.after, hl, "after")}
      ${renderBoardLayerSummaries(step.after)}
    </div>
  </div>`;
}

async function openTrialTrace(trialIndex) {
  const summary = analyzeSession.report?.results?.find((r) => r.trialIndex === trialIndex);
  if (!summary || !analyzeSession.raw) return;

  analyzeSession.selectedIndex = trialIndex;
  renderTrialListOnly();

  const detailEl = document.getElementById("trialDetail");
  const fork = isForkReport() || Array.isArray(summary.trace);

  // Fork leaves keep slim traces (actions only); hydrate boards on open — not seed re-playout.
  if (fork && Array.isArray(summary.trace)) {
    if (detailEl) {
      detailEl.hidden = false;
      detailEl.innerHTML = `<p>正在展开支路 #${summary.branchId ?? trialIndex}…</p>`;
    }
    await new Promise((r) => setTimeout(r, 10));
    hydrateForkLeafTrace(analyzeSession.raw, summary, {
      enabledOps: analyzeSession.report?.config?.enabledOps,
    });
    // Recompute mix with current classifier (matches strip / step tags).
    summary.opMix = summarizeOpSkillMix(
      summary.trace,
      normalizeEnabledOps(analyzeSession.report?.config?.enabledOps),
    );
    renderTraceDetail(summary, summary);
    return;
  }

  if (detailEl) {
    detailEl.hidden = false;
    detailEl.innerHTML = `<p>正在重放局 #${trialIndex} 的逐步过程…</p>`;
  }

  await new Promise((r) => setTimeout(r, 20));

  const traced = playout(analyzeSession.raw, {
    strategy: analyzeSession.report.config.strategy,
    maxMoves: analyzeSession.report.config.maxMoves,
    seed: summary.seed,
    enabledOps: analyzeSession.report.config.enabledOps,
    trace: true,
    topK: 5,
  });

  renderTraceDetail(summary, traced);
}

async function runDifficultyAnalysis() {
  const raw = els.levelInput.value.trim();
  if (!raw) {
    setLevelError("请先粘贴关卡数据");
    return;
  }

  syncAnalyzeModeUi();
  const mode = readAnalyzeMode();
  const trials = readAnalyzeTrials();
  if (els.analyzeTrials) els.analyzeTrials.value = String(trials);

  setLevelError("");
  els.analyzeResult.hidden = false;
  renderAnalyzeProgress({
    done: 0,
    total: trials,
    elapsedMs: 0,
    etaMs: 0,
    msPerTrial: 0,
  });
  els.btnAnalyze.disabled = true;
  if (els.analyzeTrials) els.analyzeTrials.disabled = true;
  if (els.analyzeMode) els.analyzeMode.disabled = true;

  await new Promise((r) => setTimeout(r, 30));

  try {
    const enabledOps = readEnabledOpsFromUi();
    saveEnabledOps(enabledOps);
    const report = await analyzeLevelOffMain(raw, {
      mode,
      trials,
      maxBranches: mode === "fork" ? trials : undefined,
      maxForkWidth: 8,
      strategy: "greedy",
      maxMoves: 2500,
      seed: 42,
      enabledOps,
      slimResults: false,
      chunkSize: trials > 2000 ? 20 : 4,
      onProgress: renderAnalyzeProgress,
    });

    if (!report?.results?.length) {
      // Fallback if an old worker still stripped results.
      const { analyzeForkAsync } = await import("./analyze.js?v=20260803m");
      const full =
        mode === "fork"
          ? await analyzeForkAsync(raw, {
              maxBranches: trials,
              maxForkWidth: 8,
              maxMoves: 2500,
              seed: 42,
              enabledOps,
              onProgress: renderAnalyzeProgress,
            })
          : await analyzeLevelAsync(raw, {
              trials,
              strategy: "greedy",
              maxMoves: 2500,
              seed: 42,
              enabledOps,
              chunkSize: trials > 2000 ? 20 : 4,
              onProgress: renderAnalyzeProgress,
            });
      analyzeSession.raw = raw;
      analyzeSession.report = full;
      analyzeSession.filter = "all";
      analyzeSession.page = 0;
      analyzeSession.selectedIndex = null;
      renderAnalyzeReport(full);
      return;
    }

    analyzeSession.raw = raw;
    analyzeSession.report = report;
    analyzeSession.filter = "all";
    analyzeSession.page = 0;
    analyzeSession.selectedIndex = null;

    renderAnalyzeReport(report);
  } catch (error) {
    els.analyzeResult.hidden = true;
    setLevelError(error.message || "分析失败");
  } finally {
    els.btnAnalyze.disabled = false;
    if (els.analyzeTrials) els.analyzeTrials.disabled = false;
    if (els.analyzeMode) els.analyzeMode.disabled = false;
  }
}

els.analyzeResult?.addEventListener("change", (event) => {
  if (event.target?.id === "trialFilter") {
    analyzeSession.filter = event.target.value;
    analyzeSession.page = 0;
    analyzeSession.selectedIndex = null;
    const detailEl = document.getElementById("trialDetail");
    if (detailEl) {
      detailEl.hidden = true;
      detailEl.innerHTML = "";
    }
    renderTrialListOnly();
  }
});

/** Walk ancestors (SVG-safe): find element carrying data-trial. */
function findTrialClickTarget(start) {
  let el = start;
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  while (el && el !== els.analyzeResult) {
    if (typeof el.getAttribute === "function") {
      const raw = el.getAttribute("data-trial");
      if (raw != null && raw !== "") {
        const isRow =
          el.classList?.contains("trial-row") || el.classList?.contains("fork-diag-node");
        if (isRow || el.tagName === "BUTTON") {
          const trialIndex = Number(raw);
          if (Number.isFinite(trialIndex)) return { el, trialIndex };
        }
      }
    }
    el = el.parentElement;
  }
  return null;
}

els.analyzeResult?.addEventListener("click", (event) => {
  const copyBtn = event.target.closest?.(".mini-copy-btn");
  if (copyBtn) {
    event.preventDefault();
    event.stopPropagation();
    copyBoardTopTwoLayers(
      Number(copyBtn.dataset.copyStep),
      copyBtn.dataset.copyPhase,
      copyBtn,
    ).catch((err) => setLevelError(err.message || String(err)));
    return;
  }

  const pageBtn = event.target.closest?.(".trial-page-btn");
  if (pageBtn) {
    analyzeSession.page += Number(pageBtn.dataset.dir);
    renderTrialListOnly();
    return;
  }

  const hit = findTrialClickTarget(event.target);
  if (hit) {
    openTrialTrace(hit.trialIndex).catch((err) => {
      setLevelError(err.message || String(err));
    });
  }
});

els.btnSample.addEventListener("click", fillSample);
els.btnAnalyze.addEventListener("click", () => {
  runDifficultyAnalysis().catch((err) => {
    setLevelError(err.message || String(err));
    els.btnAnalyze.disabled = false;
    if (els.analyzeMode) els.analyzeMode.disabled = false;
  });
});
els.btnLoadLevel.addEventListener("click", () => loadFromInput({ autoStart: true }));
els.analyzeMode?.addEventListener("change", () => {
  syncAnalyzeModeUi();
  if (readAnalyzeMode() === "fork" && Number(els.analyzeTrials?.value) === 120) {
    els.analyzeTrials.value = "64";
  }
});

els.btnSimOpsAll?.addEventListener("click", () => setAllSimOps(true));
els.btnSimOpsNone?.addEventListener("click", () => setAllSimOps(false));
document.getElementById("simOpsPresets")?.addEventListener("click", (event) => {
  const btn = event.target.closest?.("[data-ops-preset]");
  if (!btn) return;
  applySimOpsPreset(btn.dataset.opsPreset);
});
els.simOpsList?.addEventListener("change", (event) => {
  if (event.target?.matches?.("input[data-sim-op]")) {
    saveEnabledOps(readEnabledOpsFromUi());
    syncSimOpsPresetButtons();
  }
});

renderSimOpsPanel();
syncAnalyzeModeUi();
fillSample();

try {
  state.shelves = cloneShelves(parseLevelData(SAMPLE_LEVEL).shelves);
  state.timeLeft = estimateTime(state.shelves);
  render();
} catch (error) {
  console.error(error);
  setLevelError(`初始化失败：${error.message || error}`);
  setHint("关卡渲染失败，请刷新或检查控制台报错");
}

showModal({
  kicker: "Goods Sort",
  title: "限时货架三消",
  text: "三格货架可拖放并凑齐 3 个相同消除。单格货架只能移出不能移入。⭐999 单击即可消除。",
  primary: "开始游戏",
  onPrimary: () => startLevel({ resetBoosters: true }),
});
