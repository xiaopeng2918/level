/** Pure puzzle engine — no DOM, no timer. Used by game UI & difficulty analyzer. */

export const TRIPLE_WIDTH = 3;
export const SINGLE_WIDTH = 1;
export const SPECIAL_CLEAR_ID = 999;

export function isSpecialClearId(id) {
  return Number(id) === SPECIAL_CLEAR_ID;
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

export function parseLevelData(raw) {
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
    throw new Error("关卡必须是非空数组");
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
      throw new Error(`货架 ${shelfIndex} 各层宽度必须一致`);
    }
    return { layers, width, outputOnly: width === SINGLE_WIDTH };
  });

  const counts = new Map();
  let specials = 0;
  for (const shelf of shelves) {
    for (const layer of shelf.layers) {
      for (const id of layer) {
        if (id === 0) continue;
        if (isSpecialClearId(id)) {
          specials += 1;
          continue;
        }
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
  }

  const bad = [...counts.entries()].filter(([, c]) => c % 3 !== 0);
  const warning =
    bad.length > 0
      ? `警告：这些 ID 数量不是 3 的倍数：${bad.map(([id, c]) => `${id}×${c}`).join("，")}`
      : "";

  return { shelves, warning, counts, specials };
}

export function cloneShelves(sourceShelves) {
  return sourceShelves.map((shelf) => ({
    width: shelf.width,
    outputOnly: shelf.outputOnly ?? shelf.width === SINGLE_WIDTH,
    layers: shelf.layers.map((layer) => [...layer]),
  }));
}

export function createState(rawLevel) {
  const parsed = parseLevelData(rawLevel);
  return {
    shelves: cloneShelves(parsed.shelves),
    meta: parsed,
  };
}

export function frontLayer(shelf) {
  return shelf.layers[0] ?? null;
}

export function shelfWidth(shelf) {
  return shelf.width ?? frontLayer(shelf)?.length ?? TRIPLE_WIDTH;
}

export function isOutputOnlyShelf(shelf) {
  return Boolean(shelf.outputOnly || shelfWidth(shelf) === SINGLE_WIDTH);
}

export function isLayerEmpty(layer) {
  return layer.every((id) => id === 0);
}

/** Player-visible: current front is not the last layer iff any deeper layer has items. */
export function hasContentBehind(shelf) {
  for (let i = 1; i < shelf.layers.length; i += 1) {
    if (!isLayerEmpty(shelf.layers[i])) return true;
  }
  return false;
}

export function isLayerMatched(layer) {
  if (!layer || layer.length !== TRIPLE_WIDTH) return false;
  if (layer.some((id) => id === 0)) return false;
  if (isSpecialClearId(layer[0])) return false;
  return layer.every((id) => id === layer[0]);
}

export function firstEmptySlot(layer) {
  return layer.findIndex((id) => id === 0);
}

export function pruneShelf(shelf) {
  while (shelf.layers.length > 0 && isLayerEmpty(shelf.layers[0])) {
    shelf.layers.shift();
  }
}

export function countItems(shelves) {
  return shelves.reduce(
    (sum, shelf) =>
      sum + shelf.layers.reduce((a, layer) => a + layer.filter((id) => id !== 0).length, 0),
    0,
  );
}

export function countLayers(shelves) {
  return shelves.reduce((sum, shelf) => sum + shelf.layers.length, 0);
}

export function canPlaceOnShelf(shelves, shelfIndex) {
  const shelf = shelves[shelfIndex];
  if (!shelf || isOutputOnlyShelf(shelf)) return false;
  if (shelf.layers.length === 0) return true;
  return firstEmptySlot(shelf.layers[0]) !== -1;
}

function frontItemCount(shelf) {
  const layer = frontLayer(shelf);
  if (!layer) return 0;
  return layer.filter((id) => id !== 0).length;
}

function countReceivableEmptySlots(shelves, excludeShelfIndex = -1) {
  let empty = 0;
  shelves.forEach((shelf, index) => {
    if (index === excludeShelfIndex) return;
    if (isOutputOnlyShelf(shelf)) return;
    const layer = frontLayer(shelf);
    if (!layer) {
      empty += shelfWidth(shelf) || TRIPLE_WIDTH;
      return;
    }
    empty += layer.filter((id) => id === 0).length;
  });
  return empty;
}

export function canEliminateOnFront(shelves) {
  const visibleCounts = new Map();
  for (const shelf of shelves) {
    const layer = frontLayer(shelf);
    if (!layer) continue;
    if (isLayerMatched(layer)) return true;
    for (const id of layer) {
      if (id === 0) continue;
      if (isSpecialClearId(id)) return true;
      visibleCounts.set(id, (visibleCounts.get(id) || 0) + 1);
    }
  }
  for (const count of visibleCounts.values()) {
    if (count >= 3) return true;
  }
  return false;
}

export function canExposeNewLayer(shelves) {
  return shelves.some((shelf, index) => {
    const items = frontItemCount(shelf);
    if (items <= 0) return false;
    return countReceivableEmptySlots(shelves, index) >= items;
  });
}

export function isBoardFailed(shelves) {
  if (countItems(shelves) === 0) return false;
  if (canEliminateOnFront(shelves)) return false;
  if (canExposeNewLayer(shelves)) return false;
  return true;
}

export function isWon(shelves) {
  return countItems(shelves) === 0;
}

/** Resolve all completed front matches + empty-front prunes. */
export function resolveBoard(shelves) {
  let guard = 0;
  let matches = 0;
  while (guard < 40) {
    guard += 1;
    let changed = false;
    for (let i = 0; i < shelves.length; i += 1) {
      const layer = frontLayer(shelves[i]);
      if (layer && isLayerMatched(layer)) {
        shelves[i].layers.shift();
        matches += 1;
        changed = true;
      }
    }
    for (const shelf of shelves) {
      const before = shelf.layers.length;
      pruneShelf(shelf);
      if (shelf.layers.length !== before) changed = true;
    }
    if (!changed) break;
  }
  return matches;
}

export function clearSpecial(shelves, shelfIndex, slotIndex) {
  const layer = frontLayer(shelves[shelfIndex]);
  if (!layer || !isSpecialClearId(layer[slotIndex])) return false;
  layer[slotIndex] = 0;
  pruneShelf(shelves[shelfIndex]);
  resolveBoard(shelves);
  return true;
}

export function tryMove(shelves, fromShelf, fromSlot, toShelf, toSlot) {
  const source = shelves[fromShelf];
  const target = shelves[toShelf];
  const sourceLayer = frontLayer(source);
  if (!source || !target || !sourceLayer) return false;

  const itemId = sourceLayer[fromSlot];
  if (!itemId || isSpecialClearId(itemId)) return false;
  if (isOutputOnlyShelf(target)) return false;

  if (target.layers.length === 0) {
    target.layers.push(Array(TRIPLE_WIDTH).fill(0));
    target.width = TRIPLE_WIDTH;
    target.outputOnly = false;
  }

  const targetLayer = frontLayer(target);
  if (!targetLayer || targetLayer.length !== TRIPLE_WIDTH) return false;

  let destSlot = toSlot;
  if (destSlot == null || destSlot < 0 || destSlot >= targetLayer.length) {
    destSlot = firstEmptySlot(targetLayer);
  }
  if (destSlot === -1 || destSlot == null) return false;
  if (fromShelf === toShelf && fromSlot === destSlot) return false;

  if (targetLayer[destSlot] !== 0) {
    if (fromShelf === toShelf) return false;
    destSlot = firstEmptySlot(targetLayer);
    if (destSlot === -1) return false;
  }

  sourceLayer[fromSlot] = 0;
  targetLayer[destSlot] = itemId;
  pruneShelf(source);
  resolveBoard(shelves);
  return true;
}

function collectMoveEndpoints(shelves) {
  const sources = [];
  const targets = [];
  shelves.forEach((shelf, shelfIndex) => {
    const layer = frontLayer(shelf);
    if (layer) {
      layer.forEach((id, slot) => {
        if (id !== 0 && !isSpecialClearId(id)) {
          sources.push({ shelf: shelfIndex, slot, id });
        }
      });
    }
    if (!canPlaceOnShelf(shelves, shelfIndex)) return;
    if (!layer) {
      for (let slot = 0; slot < TRIPLE_WIDTH; slot += 1) {
        targets.push({ shelf: shelfIndex, slot });
      }
      return;
    }
    layer.forEach((id, slot) => {
      if (id === 0) targets.push({ shelf: shelfIndex, slot });
    });
  });
  return { sources, targets };
}

/** True if at least one legal special or cross-shelf move exists (early-exit). */
export function hasLegalAction(shelves) {
  for (let shelfIndex = 0; shelfIndex < shelves.length; shelfIndex += 1) {
    const layer = frontLayer(shelves[shelfIndex]);
    if (!layer) continue;
    for (let slot = 0; slot < layer.length; slot += 1) {
      if (isSpecialClearId(layer[slot])) return true;
    }
  }
  const { sources, targets } = collectMoveEndpoints(shelves);
  if (!sources.length || !targets.length) return false;
  for (const src of sources) {
    for (const dst of targets) {
      if (src.shelf !== dst.shelf) return true;
    }
  }
  return false;
}

/**
 * Legal actions that clear cells on one shelf (specials on it + moves from it).
 * Same set as filtering listActions to that shelf — cheaper for dig DFS.
 */
export function listActionsFromShelf(shelves, shelfIndex) {
  const actions = [];
  const layer = frontLayer(shelves[shelfIndex]);
  if (!layer) return actions;

  layer.forEach((id, slot) => {
    if (isSpecialClearId(id)) {
      actions.push({ type: "special", shelf: shelfIndex, slot });
    }
  });

  const sources = [];
  layer.forEach((id, slot) => {
    if (id !== 0 && !isSpecialClearId(id)) {
      sources.push({ slot, id });
    }
  });
  if (!sources.length) return actions;

  const { targets } = collectMoveEndpoints(shelves);
  for (const src of sources) {
    for (const dst of targets) {
      if (dst.shelf === shelfIndex) continue;
      actions.push({
        type: "move",
        fromShelf: shelfIndex,
        fromSlot: src.slot,
        toShelf: dst.shelf,
        toSlot: dst.slot,
        id: src.id,
      });
    }
  }
  return actions;
}

/**
 * Enumerate legal actions:
 * - { type: 'special', shelf, slot }
 * - { type: 'move', fromShelf, fromSlot, toShelf, toSlot }
 */
export function listActions(shelves) {
  const actions = [];

  shelves.forEach((shelf, shelfIndex) => {
    const layer = frontLayer(shelf);
    if (!layer) return;
    layer.forEach((id, slot) => {
      if (isSpecialClearId(id)) {
        actions.push({ type: "special", shelf: shelfIndex, slot });
      }
    });
  });

  const { sources, targets } = collectMoveEndpoints(shelves);
  for (const src of sources) {
    for (const dst of targets) {
      // Same-shelf rearrangement never helps: matches ignore order, empties are fungible.
      if (src.shelf === dst.shelf) continue;
      actions.push({
        type: "move",
        fromShelf: src.shelf,
        fromSlot: src.slot,
        toShelf: dst.shelf,
        toSlot: dst.slot,
        id: src.id,
      });
    }
  }

  return actions;
}

export function applyAction(shelves, action) {
  if (action.type === "special") {
    return clearSpecial(shelves, action.shelf, action.slot);
  }
  if (action.type === "move") {
    return tryMove(shelves, action.fromShelf, action.fromSlot, action.toShelf, action.toSlot);
  }
  return false;
}

export function hashShelves(shelves) {
  return shelves
    .map((shelf) => shelf.layers.map((layer) => layer.join(",")).join("/"))
    .join("|");
}

export function staticProfile(shelves) {
  let items = 0;
  let specials = 0;
  let maxDepth = 0;
  let depthSum = 0;
  let singles = 0;
  let triples = 0;
  const typeCounts = new Map();

  for (const shelf of shelves) {
    if (isOutputOnlyShelf(shelf)) singles += 1;
    else triples += 1;
    maxDepth = Math.max(maxDepth, shelf.layers.length);
    depthSum += shelf.layers.length;
    for (const layer of shelf.layers) {
      for (const id of layer) {
        if (id === 0) continue;
        items += 1;
        if (isSpecialClearId(id)) specials += 1;
        else typeCounts.set(id, (typeCounts.get(id) || 0) + 1);
      }
    }
  }

  const types = typeCounts.size;
  const oddTypes = [...typeCounts.values()].filter((c) => c % 3 !== 0).length;

  return {
    shelves: shelves.length,
    singles,
    triples,
    items,
    specials,
    types,
    oddTypes,
    maxDepth,
    avgDepth: shelves.length ? depthSum / shelves.length : 0,
    frontPotentialMatch: canEliminateOnFront(shelves),
    canExpose: canExposeNewLayer(shelves),
    startDeadlock: isBoardFailed(shelves),
  };
}
