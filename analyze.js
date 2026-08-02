/**
 * Level difficulty simulation (movement only, no timer).
 * Strategies + Monte Carlo deadlock / win metrics.
 */

import {
  createState,
  cloneShelves,
  countItems,
  countLayers,
  listActions,
  listActionsFromShelf,
  hasLegalAction,
  applyAction,
  isWon,
  isBoardFailed,
  staticProfile,
  frontLayer,
  isSpecialClearId,
  hashShelves,
  hasContentBehind,
  isLayerMatched,
  canPlaceOnShelf,
} from "./engine.js";

/** Selectable greedy simulation operations (reason ids). */
export const SIM_OP_DEFS = [
  {
    id: "special",
    label: "点999",
    scene: "场上有特殊清除格 999 时，优先单击消去，为腾空位或翻层做准备。",
    score: "固定 1000 分（最高优先，出现即优先点）。",
  },
  {
    id: "match3",
    label: "凑三",
    scene: "单步把物品搬到目标架后，该架首层立刻形成三个相同并消除。",
    score: "固定 +800。机会充裕时与多步凑三同分并随机选组；暴露机会稀缺（≤2）时才叠下层/留空等区别分。通关 +500；消后无着 −5000。",
  },
  {
    id: "setup3",
    label: "首层多步凑三",
    scene: "首层已有至少 3 个同色但分散在不同架，用多步把它们凑到同一架再消除。",
    score: "固定 +800。有可走首层凑三时优先于翻层；优先只消一架的落点。稀缺时按下层空位等区别打分。通关 +500；消后无着 −5000。",
  },
  {
    id: "setupReveal",
    label: "选架翻层",
    scene: "独立策略：非稀缺时也可按下层质量选凑三落点；稀缺时首层多步凑三本身就会按消架选层。暴露机会≈⌊空位/3⌋+首层可消组数。",
    score: "不单独成步；稀缺时放大下层质量分。非稀缺且关闭时，凑三保持同分随机。",
  },
  {
    id: "pair",
    label: "凑对",
    scene: "搬到已有一个同色的空位，先凑成一对，为后续凑三铺路。",
    score: "单步原子搬移：+80。可与翻层/单格/留空等加分叠加。",
  },
  {
    id: "digMatch",
    label: "翻层可消",
    scene: "清空非末层货架的首层后露出下层，且露出的物品能与首层已有同色凑成可消。",
    score: "合成计划：非稀缺 760−手数×45；稀缺固定 760。可叠下层空位/两层≥3。通关 +500；无着/无空 −5000。单步碰巧翻开可消 +220。",
  },
  {
    id: "digReveal",
    label: "多步翻层",
    scene: "清空非末层货架的首层并露出下层，但当前还不能立刻消除（纯翻层推进）。",
    score: "合成计划：非稀缺 400−手数×40；稀缺固定 400。翻出 id 在全场首层+全场下一层合计≥3 时加分（不必首层已有）。通关 +500；无着/无空 −5000。",
  },
  {
    id: "digLayer",
    label: "露出下层",
    scene: "翻层总开关之一：与「翻层可消 / 多步翻层」一起决定是否搜翻层计划。若后两者有勾选，以它们为准；仅勾本项时才允许任意翻层。",
    score: "不单独计分。可消/不可消分别由「翻层可消」「多步翻层」勾选控制，不再被本项强行放行。",
  },
  {
    id: "dig",
    label: "翻非末层",
    scene: "从还有下层的货架往外搬，本步尚未翻开下层，属于翻层过程中的中间搬移。",
    score: "单步原子搬移：+30（源架有下层但本步未翻开）。可与凑对/留空等叠加。",
  },
  {
    id: "single",
    label: "清单格",
    scene: "从宽度为 1、只出不进的货架往外搬物品，优先腾出单格货架。",
    score: "单步原子搬移：+20（源架宽度为 1）。可与其它加分叠加。",
  },
  {
    id: "move",
    label: "普通搬",
    scene: "不属于以上策略的普通货架间搬移，作为低优先级兜底候选。",
    score: "基础分多为 0；若目标架搬后仍留空位，每个空位 +3（留空加分）。",
  },
];

export function defaultEnabledOps() {
  return Object.fromEntries(SIM_OP_DEFS.map((op) => [op.id, true]));
}

/** Preset op sets from the difficulty-tier table (简单→超困难). */
export const SIM_OP_PRESETS = {
  easy: {
    label: "简单",
    ops: {
      special: true,
      match3: true,
      setup3: true,
      move: true,
      pair: true,
      digMatch: false,
      dig: true,
      digReveal: true,
      setupReveal: false,
      single: true,
      digLayer: true,
    },
  },
  normal: {
    label: "普通",
    ops: {
      special: true,
      match3: true,
      setup3: true,
      move: true,
      pair: true,
      digMatch: true,
      dig: true,
      digReveal: true,
      setupReveal: false,
      single: true,
      digLayer: true,
    },
  },
  hard: {
    label: "困难",
    ops: {
      special: true,
      match3: true,
      setup3: true,
      move: true,
      pair: true,
      digMatch: true,
      dig: true,
      digReveal: true,
      setupReveal: true,
      single: true,
      digLayer: true,
    },
  },
  ultra: {
    label: "超困难",
    ops: Object.fromEntries(SIM_OP_DEFS.map((op) => [op.id, true])),
  },
};

export function normalizeEnabledOps(input) {
  const base = defaultEnabledOps();
  if (!input || typeof input !== "object") return base;
  for (const op of SIM_OP_DEFS) {
    if (Object.prototype.hasOwnProperty.call(input, op.id)) {
      base[op.id] = Boolean(input[op.id]);
    }
  }
  return base;
}

function isOpEnabled(enabledOps, reason) {
  if (reason === "random" || reason === "fallback") return true;
  // setupReveal is a modifier, not a standalone move reason.
  if (reason === "setupReveal") return enabledOps.setupReveal !== false;
  // digMatch / digReveal follow their own checkboxes. digLayer alone (both off)
  // still allows either dig reason (legacy “任意翻层”).
  if (reason === "digMatch" || reason === "digReveal") {
    if (Object.prototype.hasOwnProperty.call(enabledOps, reason)) {
      if (enabledOps[reason]) return true;
      if (enabledOps[reason] === false) return false;
    }
    return enabledOps.digLayer !== false;
  }
  if (!Object.prototype.hasOwnProperty.call(enabledOps, reason)) return true;
  return enabledOps[reason] !== false;
}

function wantsSetupReveal(enabledOps) {
  return !enabledOps || enabledOps.setupReveal !== false;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pickRandom(arr, random) {
  return arr[Math.floor(random() * arr.length)];
}

function countFrontTypes(shelves) {
  const map = new Map();
  for (const shelf of shelves) {
    const layer = frontLayer(shelf);
    if (!layer) continue;
    for (const id of layer) {
      if (!id || isSpecialClearId(id)) continue;
      map.set(id, (map.get(id) || 0) + 1);
    }
  }
  return map;
}

function countTypeAll(shelves, typeId) {
  let n = 0;
  for (const shelf of shelves) {
    for (const layer of shelf.layers) {
      for (const id of layer) {
        if (id === typeId) n += 1;
      }
    }
  }
  return n;
}

/**
 * Remaining expose-new-layer chances:
 * - digChances: ⌊placeable empties / 3⌋（每 3 空位算可搬空翻一层）
 * - matchGroups: front-visible eliminable triples (⌊count/3⌋ per id)
 */
export function estimateRevealChances(shelves) {
  const empties = countPlaceableEmpties(shelves);
  const digChances = Math.floor(empties / 3);

  let diggable = 0;
  for (const shelf of shelves) {
    if (hasContentBehind(shelf)) diggable += 1;
  }

  let matchGroups = 0;
  for (const n of countFrontTypes(shelves).values()) {
    matchGroups += Math.floor(n / 3);
  }

  const chances = digChances + matchGroups;
  return {
    chances,
    empties,
    diggable,
    digChances,
    matchGroups,
  };
}

export function isRevealScarce(shelves) {
  const { chances, diggable } = estimateRevealChances(shelves);
  return diggable > 0 && chances <= 2;
}

/** Static quality of a yet-to-be-exposed next layer: empty slots only. */
function scorePeekLayer(_shelves, peek) {
  if (!peek || !peek.length) return 0;
  return peek.filter((id) => id === 0).length * 28;
}

/** Apply scarce-reveal multiplier on layer quality (no best/worst layer bonus). */
function applyScarceRevealAdjust(_shelves, score, parts, ev) {
  if (!ev?.reveals?.length) return { score, parts };
  const mult = 3;
  const baseBonus = ev.revealBonus || 0;
  // revealBonus already added by caller once; add the extra (mult-1)× here
  const extra = baseBonus * (mult - 1);
  score += extra;
  parts = [...parts, `稀缺选层×${mult}`];
  return { score, parts };
}

function frontTripleTypes(shelves) {
  const set = new Set();
  for (const [id, n] of countFrontTypes(shelves)) {
    if (n >= 3) set.add(id);
  }
  return set;
}

function matchedTypeId(before, after, typeSet) {
  for (const t of typeSet) {
    if (countTypeAll(after, t) <= countTypeAll(before, t) - 3) return t;
  }
  return null;
}

function peekEmptyCount(shelf) {
  const peek = shelf?.layers?.[1];
  if (!peek) return 0;
  return peek.filter((id) => id === 0).length;
}

/** Rank diggable shelves by lower-layer empties (+ already holding match types). */
function promisingClearShelves(shelves, typeSet = null, limit = 3) {
  const rows = [];
  for (let i = 0; i < shelves.length; i += 1) {
    if (!hasContentBehind(shelves[i])) continue;
    const empties = peekEmptyCount(shelves[i]);
    if (empties <= 0) continue;
    const layer = frontLayer(shelves[i]) || [];
    let typeHits = 0;
    if (typeSet?.size) {
      for (const id of layer) {
        if (typeSet.has(id)) typeHits += 1;
      }
    }
    rows.push({ shelf: i, empties, typeHits });
  }
  rows.sort(
    (a, b) =>
      b.empties - a.empties || b.typeHits - a.typeHits || a.shelf - b.shelf,
  );
  return rows.slice(0, limit);
}

function quickFrontSetupScore(
  shelves,
  action,
  typeSet,
  useRevealPick = true,
  scarce = false,
  preferShelf = -1,
) {
  if (action.type === "special" || !typeSet.size) return 0;
  let score = 0;
  const layer = frontLayer(shelves[action.toShelf]);
  if (layer && layer.length === 3 && layer[action.toSlot] === 0) {
    const will = [layer[0], layer[1], layer[2]];
    will[action.toSlot] = action.id;
    if (will.every((id) => id !== 0 && id === will[0]) && typeSet.has(will[0])) score += 800;
    if (typeSet.has(action.id)) {
      const same = will.filter((id) => id === action.id).length;
      score += same * 60;
      if (same === 2) score += 100;
    }
  }
  const srcLayer = frontLayer(shelves[action.fromShelf]);
  if (srcLayer && !typeSet.has(action.id)) {
    for (const t of typeSet) {
      if (srcLayer.filter((id) => id === t).length >= 2) score += 140;
    }
  }
  if (!useRevealPick) return score;

  // Prefer assembling on shelves whose next layer has empties (current quality metric).
  const dest = shelves[action.toShelf];
  if (dest && hasContentBehind(dest) && dest.layers[1]) {
    const destEmpties = peekEmptyCount(dest);
    const destFactor = scarce ? 2.5 : 1;
    if (destEmpties > 0) {
      score += Math.round(destEmpties * 28 * destFactor);
      if (typeSet.has(action.id)) score += Math.round(destEmpties * 40 * destFactor);
    } else if (typeSet.has(action.id)) {
      score += Math.round(20 * destFactor);
    }
  }

  // Scarce: evacuating non-match off a peek-with-empties shelf frees a clear target.
  if (scarce && action.type === "move") {
    const src = shelves[action.fromShelf];
    if (src && hasContentBehind(src) && !typeSet.has(action.id)) {
      const srcEmpties = peekEmptyCount(src);
      if (srcEmpties > 0) score += 50 + srcEmpties * 60;
    }
  }

  // Seeded search: strongly prefer building the match on a chosen clear shelf.
  if (preferShelf >= 0 && action.type === "move") {
    if (action.toShelf === preferShelf && typeSet.has(action.id)) score += 220;
    if (action.fromShelf === preferShelf && !typeSet.has(action.id)) score += 200;
    if (action.fromShelf === preferShelf && typeSet.has(action.id)) score -= 80;
  }
  return score;
}

function actionKey(action) {
  if (!action) return "";
  if (action.type === "special") return `s:${action.shelf}:${action.slot}`;
  if (action.type === "plan") return `p:${(action.moves || []).map(actionKey).join(">")}`;
  return `m:${action.fromShelf}:${action.fromSlot}:${action.toShelf}:${action.toSlot}:${action.id}`;
}

function copySetupPlan(plan) {
  return {
    type: "plan",
    planKind: "setup3",
    moves: plan.moves,
    matchType: plan.matchType,
    atomicCount: plan.atomicCount,
    clearShelves: plan.clearShelves,
    _outcome: plan._outcome
      ? {
          reveals: plan._outcome.reveals,
          matchIds: plan._outcome.matchIds,
          revealBonus: plan._outcome.revealBonus,
          revealParts: plan._outcome.revealParts,
          empties: plan._outcome.empties,
          actionsLeft: plan._outcome.actionsLeft,
          won: plan._outcome.won,
        }
      : undefined,
  };
}

/** Macro plans: 2..maxLen atomic moves that eliminate a front-visible triple.
 *  When setupReveal is on, prefers clearing on shelves whose lower layer helps next.
 *  @param {Map|null} [searchCache] optional raw-plan cache (fork transposition)
 *  @param {string|null} [boardHash] hashShelves(shelves) when already known
 */
function findFrontMatchPlans(
  shelves,
  maxLen = 4,
  enabledOps = null,
  random = null,
  searchCache = null,
  boardHash = null,
) {
  const typeSet = frontTripleTypes(shelves);
  if (!typeSet.size) return [];
  const useRevealPick = wantsSetupReveal(enabledOps);
  const scarce = isRevealScarce(shelves);
  // 稀缺时首层多步凑三也必须按「消在哪架/翻哪层」区分，不依赖选架翻层开关。
  const pickClearShelf = useRevealPick || scarce;
  const effectiveMax = scarce ? Math.max(maxLen, 6) : maxLen;

  // Keep branching modest — this runs every logic step. Scarce: deeper / wider for 选层.
  const branchAt = scarce
    ? [12, 10, 8, 6, 5, 4]
    : pickClearShelf
      ? [10, 8, 6, 5]
      : [8, 6, 5, 4];
  const planCap = scarce ? 48 : pickClearShelf ? 24 : 12;
  const cacheKey = searchCache
    ? `${boardHash || hashShelves(shelves)}|s${effectiveMax}|${pickClearShelf ? 1 : 0}|${scarce ? 1 : 0}`
    : null;

  let plans;
  if (cacheKey && searchCache.has(cacheKey)) {
    plans = searchCache.get(cacheKey).map(copySetupPlan);
  } else {
    plans = [];

    function clearShelvesOf(before, after) {
      const out = [];
      for (let i = 0; i < before.length; i += 1) {
        if ((before[i]?.layers?.length || 0) > (after[i]?.layers?.length || 0)) out.push(i);
      }
      return out;
    }

    function dfs(state, path, preferShelf = -1, localCap = planCap) {
      if (plans.length >= localCap) return;
      if (path.length >= effectiveMax) return;
      const depth = path.length;
      const ranked = listActions(state)
        .map((a) => ({
          a,
          s: quickFrontSetupScore(state, a, typeSet, pickClearShelf, scarce, preferShelf),
        }))
        .sort((x, y) => y.s - x.s)
        .slice(0, branchAt[depth] ?? 4);

      for (const { a } of ranked) {
        if (plans.length >= localCap) break;
        const next = cloneShelves(state);
        if (!applyAction(next, a)) continue;
        const newPath = path.concat([a]);
        const got = matchedTypeId(shelves, next, typeSet);
        if (got != null) {
          if (newPath.length >= 2) {
            const clearShelves = clearShelvesOf(shelves, next);
            // Seeded runs only keep plans that actually clear the preferred shelf.
            if (preferShelf >= 0 && !clearShelves.includes(preferShelf)) {
              continue;
            }
            plans.push({
              type: "plan",
              planKind: "setup3",
              moves: newPath,
              matchType: got,
              atomicCount: newPath.length,
              clearShelves,
              // Avoid re-simulating the same plan in scorePlan.
              _outcome: capturePlanOutcome(shelves, next, { needRevealQuality: scarce }),
            });
          }
          continue;
        }
        if (newPath.length < effectiveMax) dfs(next, newPath, preferShelf, localCap);
      }
    }

    // Scarce/选架: seed high-value clear shelves FIRST so planCap is not filled by easy 架0 paths.
    if (pickClearShelf) {
      const seeds = promisingClearShelves(shelves, typeSet, scarce ? 5 : 3);
      const perSeed = scarce ? 8 : 5;
      for (const row of seeds) {
        if (plans.length >= planCap) break;
        const seedCap = Math.min(planCap, plans.length + perSeed);
        dfs(shelves, [], row.shelf, seedCap);
      }
    }
    dfs(shelves, [], -1, planCap);

    if (cacheKey) {
      searchCache.set(cacheKey, plans.map(copySetupPlan));
    }
  }

  // Shuffle so each match-type group keeps a random hand-count variant (手数不计分).
  if (random && plans.length > 1) {
    for (let i = plans.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [plans[i], plans[j]] = [plans[j], plans[i]];
    }
  }

  const ranked = plans
    .map((plan) => {
      const scored = scorePlan(plan, shelves, enabledOps);
      return { plan, ...scored };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.plan.atomicCount - b.plan.atomicCount ||
        a.plan.matchType - b.plan.matchType,
    );

  const uniq = [];
  const seen = new Set();
  for (const row of ranked) {
    if (row.deadly) continue;
    const clearKey = pickClearShelf
      ? (row.plan.clearShelves || []).join(",") || "none"
      : "any";
    // 稀缺/选架：同一颜色消在不同架算不同组；非稀缺：每色保留一组即可。
    const k = pickClearShelf
      ? `${row.plan.matchType}@${clearKey}`
      : `${row.plan.matchType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    row.plan._scored = {
      score: row.score,
      reason: row.reason,
      parts: row.parts,
      deadly: row.deadly,
    };
    uniq.push(row.plan);
    if (uniq.length >= (scarce ? 12 : pickClearShelf ? 8 : 6)) break;
  }
  if (!uniq.length) {
    for (const row of ranked) {
      const clearKey = pickClearShelf
        ? (row.plan.clearShelves || []).join(",") || "none"
        : "any";
      const k = pickClearShelf
        ? `${row.plan.matchType}@${clearKey}`
        : `${row.plan.matchType}`;
      if (seen.has(k)) continue;
      seen.add(k);
      row.plan._scored = {
        score: row.score,
        reason: row.reason,
        parts: row.parts,
        deadly: row.deadly,
      };
      uniq.push(row.plan);
      if (uniq.length >= 3) break;
    }
  }
  return uniq;
}

function countPlaceableEmpties(shelves) {
  let n = 0;
  for (let i = 0; i < shelves.length; i += 1) {
    if (!canPlaceOnShelf(shelves, i)) continue;
    const layer = frontLayer(shelves[i]);
    if (!layer) {
      n += 3;
      continue;
    }
    n += layer.filter((id) => id === 0).length;
  }
  return n;
}

function countFrontId(shelves, id, excludeShelf = -1) {
  let n = 0;
  for (let i = 0; i < shelves.length; i += 1) {
    if (i === excludeShelf) continue;
    const layer = frontLayer(shelves[i]);
    if (!layer) continue;
    for (const cell of layer) {
      if (cell === id) n += 1;
    }
  }
  return n;
}

function countNextLayerId(shelves, id) {
  let n = 0;
  for (const shelf of shelves) {
    const peek = shelf.layers[1];
    if (!peek) continue;
    for (const cell of peek) {
      if (cell === id) n += 1;
    }
  }
  return n;
}

/** Pair with front + (≥3 across 全场首层 + 全场下一层). */
const REVEAL_PAIR3_BONUS = 120;

/**
 * How useful is the layer exposed by a clear/dig for the *next* elimination.
 * Empties, immediate dig-match, and when a revealed id totals ≥3
 * across all fronts + all next layers (no need for a front pair already).
 */
function scoreRevealQuality(before, after, reveals) {
  if (!reveals?.length) return { bonus: 0, parts: [], matchIds: [] };
  const matchIds = digMatchIdsWithPrior(before, after, reveals);
  let bonus = 0;
  const parts = [];

  if (matchIds.length) {
    const add = 220 + (matchIds.length - 1) * 40;
    bonus += add;
    parts.push(`顺带翻层可消(id${matchIds.join(",")})+${add}`);
  }

  let layer3Applied = false;
  for (const rev of reveals) {
    const shelf = rev.shelf;
    const layer = rev.layer || [];
    const empties = layer.filter((id) => id === 0).length;
    if (empties > 0) {
      bonus += empties * 28;
      parts.push(`选架#${shelf}下层+${empties * 28}`);
    }

    if (layer3Applied) continue;
    const revealedCounts = new Map();
    for (const id of layer) {
      if (!id || isSpecialClearId(id)) continue;
      revealedCounts.set(id, (revealedCounts.get(id) || 0) + 1);
    }
    for (const [id] of revealedCounts) {
      if (matchIds.includes(id)) continue;
      // 两层≥3：全场首层(除本架旧首层) + 全场下一层，不要求首层已凑对
      const priorFront = countFrontId(before, id, shelf);
      const total = priorFront + countNextLayerId(before, id);
      if (total >= 3) {
        bonus += REVEAL_PAIR3_BONUS;
        parts.push(`两层≥3(id${id})+${REVEAL_PAIR3_BONUS}`);
        layer3Applied = true; // 同一步只计一次
        break;
      }
    }
  }

  return { bonus, parts, matchIds };
}

/** Snapshot outcome after a plan without keeping the full board (cheaper deadly check). */
function capturePlanOutcome(before, after, { needRevealQuality = true } = {}) {
  const reveals = detectReveals(before, after);
  const quality = needRevealQuality
    ? scoreRevealQuality(before, after, reveals)
    : { bonus: 0, parts: [], matchIds: [] };
  return {
    reveals,
    matchIds: quality.matchIds,
    revealBonus: quality.bonus,
    revealParts: quality.parts,
    empties: countPlaceableEmpties(after),
    actionsLeft: hasLegalAction(after) ? 1 : 0,
    won: isWon(after),
  };
}

function evaluatePlanOutcome(before, plan, opts = {}) {
  if (plan?._outcome) {
    const cached = plan._outcome;
    delete plan._outcome;
    return cached;
  }
  const after = cloneShelves(before);
  if (!applyPlan(after, plan)) return null;
  const needRevealQuality = opts.needRevealQuality !== false;
  const captured = capturePlanOutcome(before, after, { needRevealQuality });
  return { ...captured, after };
}

function scorePlan(plan, shelves = null, enabledOps = null) {
  if (plan?._scored) {
    return {
      score: plan._scored.score,
      reason: plan._scored.reason,
      parts: plan._scored.parts,
      deadly: plan._scored.deadly,
    };
  }
  if (plan.planKind === "dig") return scoreDigPlan(plan, shelves, enabledOps);
  // 凑三：非稀缺保持同分；稀缺时才按下层/留空区别打分（不依赖「选架翻层」开关）。
  const scarce = Boolean(shelves && isRevealScarce(shelves));
  const base = 800;
  let score = base;
  const parts = [`首层多步凑三(id${plan.matchType})×${plan.atomicCount}手+${base}`];
  let deadly = false;

  if (shelves) {
    const ev = evaluatePlanOutcome(shelves, plan, { needRevealQuality: scarce });
    if (!ev) {
      return { score: -1e9, reason: "setup3", parts: ["计划不可用"], deadly: true };
    }
    const won = ev.won ?? (ev.after ? isWon(ev.after) : false);
    if (scarce) {
      if (ev.revealBonus > 0) {
        score += ev.revealBonus;
        parts.push(...ev.revealParts);
        const adj = applyScarceRevealAdjust(shelves, score, parts, ev);
        score = adj.score;
        parts.length = 0;
        parts.push(...adj.parts);
      } else if (ev.reveals?.length) {
        score += 40;
        parts.push("顺带翻层+40");
      }
      if (!won && ev.empties === 0) {
        score -= 600;
        parts.push("消后无空格-600");
      } else if (ev.empties > 0) {
        score += Math.min(60, ev.empties * 8);
        parts.push(`留空位+${Math.min(60, ev.empties * 8)}`);
      }
    }
    if (won) {
      score += 500;
      parts.push("通关+500");
    } else if (ev.actionsLeft === 0) {
      score -= 5000;
      parts.push("消后无着-5000");
      deadly = true;
    }
  }

  return { score, reason: "setup3", parts, deadly };
}

/** Detect shelves whose front layer was cleared, exposing the next layer. */
function detectReveals(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    if (!b || !a) continue;
    if (b.layers.length <= a.layers.length) continue;
    const removed = b.layers.length - a.layers.length;
    const chainedMatchIds = [];
    // layers[1].. that were also wiped in the same resolve (chain clears)
    for (let li = 1; li < removed; li += 1) {
      const layer = b.layers[li];
      if (layer && isLayerMatched(layer) && !isSpecialClearId(layer[0])) {
        chainedMatchIds.push(layer[0]);
      }
    }
    const layer = frontLayer(a);
    const revealedIds = layer
      ? layer.filter((id) => id && !isSpecialClearId(id))
      : [];
    const peek = b.layers[1];
    const peekIds = peek ? peek.filter((id) => id && !isSpecialClearId(id)) : [];
    out.push({
      shelf: i,
      layer: layer ? [...layer] : peek && removed >= 1 ? [...peek] : [],
      revealedIds: revealedIds.length ? revealedIds : peekIds,
      chainedMatchIds,
    });
  }
  return out;
}

/**
 * After a dig reveal, which types can actually be eliminated (true 翻层可消):
 * - revealed layer itself is a triple, or
 * - revealed ids + prior front counts reach ≥3, or
 * - after state already has ≥3 of a revealed type on the front,
 * - or a chained clear wiped a matched lower layer in the same resolve.
 */
function digMatchIdsWithPrior(before, after, reveals) {
  const beforeFront = countFrontTypes(before);
  const afterFront = countFrontTypes(after);
  const matchIds = new Set();

  for (const rev of reveals) {
    for (const id of rev.chainedMatchIds || []) matchIds.add(id);
    if (isLayerMatched(rev.layer) && !isSpecialClearId(rev.layer[0])) {
      matchIds.add(rev.layer[0]);
    }
    const revealedCounts = new Map();
    for (const id of rev.revealedIds) {
      revealedCounts.set(id, (revealedCounts.get(id) || 0) + 1);
    }
    for (const [id, n] of revealedCounts) {
      const prior = beforeFront.get(id) || 0;
      if (n >= 3 || prior + n >= 3 || (afterFront.get(id) || 0) >= 3) {
        matchIds.add(id);
      }
    }
  }

  return [...matchIds].sort((a, b) => a - b);
}

function digMatchesPrior(before, after, reveals) {
  return digMatchIdsWithPrior(before, after, reveals).length > 0;
}

function digRelevantActions(shelves) {
  return listActions(shelves).filter((a) => {
    if (a.type === "special") return hasContentBehind(shelves[a.shelf]);
    if (a.type === "move") return hasContentBehind(shelves[a.fromShelf]);
    return false;
  });
}

function scoreDigStep(state, action) {
  let score = 0;
  if (action.type === "special" && hasContentBehind(state[action.shelf])) {
    score += 50;
    return score;
  }
  if (action.type !== "move" || !hasContentBehind(state[action.fromShelf])) return score;
  score += 40;
  const layer = frontLayer(state[action.fromShelf]);
  if (layer) {
    const left = layer.filter((id) => id !== 0 && !isSpecialClearId(id)).length;
    if (left === 1) score += 80;
    else if (left === 2) score += 30;
  }
  return score;
}

/**
 * Multi-step dig plans: clear a non-last-layer shelf until the next layer shows.
 * Search per diggable shelf so true 翻层可消 is not crowded out by variants of
 * the first reveal-only dig.
 */
function copyDigPlan(plan) {
  return {
    type: "plan",
    planKind: "dig",
    moves: plan.moves,
    atomicCount: plan.atomicCount,
    reveals: plan.reveals,
    canMatchPrior: plan.canMatchPrior,
    matchIds: plan.matchIds,
    revealShelf: plan.revealShelf,
    revealTypes: plan.revealTypes,
    _outcome: plan._outcome
      ? {
          reveals: plan._outcome.reveals,
          matchIds: plan._outcome.matchIds,
          revealBonus: plan._outcome.revealBonus,
          revealParts: plan._outcome.revealParts,
          empties: plan._outcome.empties,
          actionsLeft: plan._outcome.actionsLeft,
          won: plan._outcome.won,
        }
      : undefined,
  };
}

function findDigRevealPlans(shelves, maxLen = 4, searchCache = null, boardHash = null) {
  if (!shelves.some((s) => hasContentBehind(s))) return [];

  const cacheKey = searchCache
    ? `${boardHash || hashShelves(shelves)}|d${maxLen}`
    : null;
  if (cacheKey && searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey).map(copyDigPlan);
  }

  const plans = [];

  function actionsClearingShelf(state, shelfIndex) {
    if (!hasContentBehind(state[shelfIndex])) return [];
    return listActionsFromShelf(state, shelfIndex);
  }

  function searchClearShelf(targetShelf) {
    const found = [];
    const branchAt = [8, 6, 5, 4];

    function dfs(state, path) {
      if (found.length >= 1) return;
      if (path.length >= maxLen) return;
      const depth = path.length;
      const ranked = actionsClearingShelf(state, targetShelf)
        .map((a) => ({ a, s: scoreDigStep(state, a) }))
        .sort((x, y) => y.s - x.s)
        .slice(0, branchAt[depth] ?? 4);

      for (const { a } of ranked) {
        if (found.length >= 1) break;
        const next = cloneShelves(state);
        if (!applyAction(next, a)) continue;
        const newPath = path.length ? path.concat([a]) : [a];
        const reveals = detectReveals(shelves, next).filter((r) => r.shelf === targetShelf);
        if (reveals.length) {
          const matchIds = digMatchIdsWithPrior(shelves, next, reveals);
          found.push({
            type: "plan",
            planKind: "dig",
            moves: newPath,
            atomicCount: newPath.length,
            reveals,
            canMatchPrior: matchIds.length > 0,
            matchIds,
            revealShelf: targetShelf,
            revealTypes: [...new Set(reveals.flatMap((r) => r.revealedIds))],
            _outcome: capturePlanOutcome(shelves, next, { needRevealQuality: true }),
          });
          continue;
        }
        if (newPath.length < maxLen) dfs(next, newPath);
      }
    }

    dfs(shelves, []);
    return found;
  }

  for (let si = 0; si < shelves.length; si += 1) {
    if (!hasContentBehind(shelves[si])) continue;
    plans.push(...searchClearShelf(si));
  }

  plans.sort(
    (a, b) =>
      Number(b.canMatchPrior) - Number(a.canMatchPrior) ||
      a.atomicCount - b.atomicCount ||
      a.revealShelf - b.revealShelf,
  );

  // One best plan per shelf (prefer already-sorted match + short path).
  const uniq = [];
  const seenShelf = new Set();
  for (const p of plans) {
    const k = `${p.canMatchPrior ? "m" : "r"}:${p.revealShelf}`;
    if (seenShelf.has(k)) continue;
    seenShelf.add(k);
    uniq.push(p);
  }

  // Match digs first; keep reveal digs for every diggable shelf (sorted by peek empties).
  const matches = uniq.filter((p) => p.canMatchPrior);
  const reveals = uniq
    .filter((p) => !p.canMatchPrior)
    .sort((a, b) => {
      const ea = peekEmptyCount(shelves[a.revealShelf]);
      const eb = peekEmptyCount(shelves[b.revealShelf]);
      return eb - ea || a.atomicCount - b.atomicCount || a.revealShelf - b.revealShelf;
    });
  const diggable = shelves.filter((s) => hasContentBehind(s)).length;
  const revealCap = Math.max(diggable, 6);
  const out = matches.concat(reveals.slice(0, revealCap)).slice(0, 16);
  if (cacheKey) {
    searchCache.set(cacheKey, out.map(copyDigPlan));
  }
  return out;
}

function scoreDigPlan(plan, shelves = null, enabledOps = null) {
  const revealText = (plan.revealTypes || []).join(",") || "?";
  const matchText = (plan.matchIds || []).join(",") || revealText;
  const isMatch = plan.canMatchPrior && plan.matchIds?.length;
  const scarceHands = Boolean(shelves && isRevealScarce(shelves));
  const base = isMatch
    ? scarceHands
      ? 760
      : 760 - plan.atomicCount * 45
    : scarceHands
      ? 400
      : 400 - plan.atomicCount * 40;
  let score = base;
  const reason = isMatch ? "digMatch" : "digReveal";
  const parts = [
    isMatch
      ? `翻层可消(id${matchText})×${plan.atomicCount}手+${base}`
      : `多步翻层(露出id${revealText})×${plan.atomicCount}手+${base}`,
  ];
  if (scarceHands && plan.atomicCount > 1) {
    parts.push("稀缺不计手数");
  }

  let deadly = false;
  if (shelves) {
    const ev = evaluatePlanOutcome(shelves, plan);
    if (!ev) {
      return { score: -1e9, reason, parts: ["翻层计划不可用"], deadly: true };
    }
    const useRevealPick = wantsSetupReveal(enabledOps);
    const scarce = useRevealPick && isRevealScarce(shelves);
    const won = ev.won ?? (ev.after ? isWon(ev.after) : false);
    if (useRevealPick && ev.revealBonus > 0) {
      score += ev.revealBonus;
      parts.push(...ev.revealParts);
      if (scarce) {
        const adj = applyScarceRevealAdjust(shelves, score, parts, ev);
        score = adj.score;
        parts.length = 0;
        parts.push(...adj.parts);
      }
    }
    if (won) {
      score += 500;
      parts.push("通关+500");
    } else if (ev.actionsLeft === 0) {
      score -= 5000;
      parts.push("翻后无着-5000");
      deadly = true;
    } else if (ev.empties === 0) {
      score -= 5000;
      parts.push("翻后无空位-5000");
      deadly = true;
    } else if (ev.empties > 0) {
      score += Math.min(60, ev.empties * 8);
      parts.push(`翻后留空+${Math.min(60, ev.empties * 8)}`);
    }
  }

  return { score, reason, parts, deadly };
}

function scoreActionDetailed(shelves, action, enabledOps = null) {
  if (action.type === "plan") return scorePlan(action, shelves, enabledOps);
  if (action.type === "special") {
    return { score: 1000, reason: "special", parts: ["点999"] };
  }

  const useRevealPick = wantsSetupReveal(enabledOps);
  const scarce = Boolean(shelves && isRevealScarce(shelves));
  const target = shelves[action.toShelf];
  let layer = frontLayer(target);
  const width = layer?.length ?? 3;
  const willCreate = Array.from({ length: width }, (_, i) => (layer ? layer[i] : 0));
  willCreate[action.toSlot] = action.id;

  let score = 0;
  const parts = [];

  const isMatch3 =
    willCreate.length === 3 &&
    willCreate.every((id) => id !== 0 && id === willCreate[0]) &&
    !isSpecialClearId(willCreate[0]);
  if (isMatch3) {
    score += 800;
    parts.push("凑三+800");
  }

  const sameOnTarget = willCreate.filter((id) => id === action.id).length;
  const src = shelves[action.fromShelf];
  const srcBehind = hasContentBehind(src);
  const destBehind = hasContentBehind(target);
  // Full simulate only when a reveal or post-clear deadlock check is plausible.
  const needApply = srcBehind || (isMatch3 && destBehind) || isMatch3;

  if (needApply) {
    const snap = cloneShelves(shelves);
    const applied = applyAction(snap, action);
    if (applied) {
      const reveals = detectReveals(shelves, snap);
      if (reveals.length) {
        // 凑三：非稀缺不叠翻层分（保持组间同分）；稀缺时才按下层质量区别打分。
        if (isMatch3) {
          if (scarce) {
            const quality = scoreRevealQuality(shelves, snap, reveals);
            if (quality.bonus > 0) {
              score += quality.bonus;
              parts.push(...quality.parts);
              const adj = applyScarceRevealAdjust(shelves, score, parts, {
                reveals,
                revealBonus: quality.bonus,
              });
              score = adj.score;
              parts.length = 0;
              parts.push(...adj.parts);
            } else {
              score += 40;
              parts.push("顺带翻层+40");
            }
            if (!isWon(snap)) {
              const emptiesAfterReveal = countPlaceableEmpties(snap);
              if (emptiesAfterReveal === 0) {
                score -= 600;
                parts.push("消后无空格-600");
              } else if (emptiesAfterReveal > 0) {
                score += Math.min(60, emptiesAfterReveal * 8);
                parts.push(`留空位+${Math.min(60, emptiesAfterReveal * 8)}`);
              }
            }
          }
        } else if (useRevealPick) {
          const quality = scoreRevealQuality(shelves, snap, reveals);
          if (quality.bonus > 0) {
            score += quality.bonus;
            parts.push(...quality.parts);
            if (scarce) {
              const adj = applyScarceRevealAdjust(shelves, score, parts, {
                reveals,
                revealBonus: quality.bonus,
              });
              score = adj.score;
              parts.length = 0;
              parts.push(...adj.parts);
            }
          } else {
            score += 40;
            parts.push("顺带翻层+40");
          }
        } else {
          const matchIds = digMatchIdsWithPrior(shelves, snap, reveals);
          const revealedIds = [...new Set(reveals.flatMap((r) => r.revealedIds))];
          if (matchIds.length && enabledOps?.digMatch !== false) {
            score += 220;
            parts.push(`翻层可消(id${matchIds.join(",")})+220`);
          } else if (!matchIds.length && enabledOps?.digReveal !== false) {
            score += 90;
            parts.push(`多步翻层(露出id${revealedIds.join(",") || "?"})+90`);
          } else if (srcBehind) {
            score += 30;
            parts.push("非末层+30");
          }
        }
        if (!isWon(snap) && !isMatch3) {
          const emptiesAfterReveal = countPlaceableEmpties(snap);
          if (!hasLegalAction(snap)) {
            score -= 5000;
            parts.push("翻后无着-5000");
          } else if (emptiesAfterReveal === 0) {
            score -= 5000;
            parts.push("翻后无空位-5000");
          }
        }
      } else if (srcBehind && !isMatch3) {
        score += 30;
        parts.push("非末层+30");
      }
      if (isMatch3) {
        if (isWon(snap)) {
          score += 500;
          parts.push("通关+500");
        } else if (!hasLegalAction(snap)) {
          score -= 5000;
          parts.push("消后无着-5000");
        }
      }
    } else if (srcBehind && !isMatch3) {
      score += 30;
      parts.push("非末层+30");
    }
  } else if (srcBehind && !isMatch3) {
    score += 30;
    parts.push("非末层+30");
  }

  if (src.width === 1 && !isMatch3) {
    score += 20;
    parts.push("单格源+20");
  }
  if (!isMatch3 && sameOnTarget === 2) {
    score += 80;
    parts.push("凑对+80");
  }
  const emptiesAfter = willCreate.filter((id) => id === 0).length;
  if (!isMatch3 && emptiesAfter > 0) {
    score += emptiesAfter * 3;
    parts.push(`留空+${emptiesAfter * 3}`);
  }

  let reason = "move";
  if (parts.some((p) => p.startsWith("凑三"))) reason = "match3";
  else if (parts.some((p) => p.startsWith("凑对"))) reason = "pair";
  else if (parts.some((p) => p.startsWith("翻层可消") || p.startsWith("顺带翻层可消"))) reason = "digMatch";
  else if (parts.some((p) => p.startsWith("多步翻层") || p.startsWith("顺带翻层"))) reason = "digReveal";
  else if (parts.some((p) => p.startsWith("选架#"))) reason = "setupReveal";
  else if (parts.some((p) => p.startsWith("非末层"))) reason = "dig";
  else if (parts.some((p) => p.startsWith("单格"))) reason = "single";

  if (parts.some((p) => p.startsWith("凑三"))) reason = "match3";

  return { score, reason, parts };
}

function describeAction(action) {
  if (!action) return "—";
  if (action.type === "special") return `点999 @货架${action.shelf}格${action.slot}`;
  if (action.type === "plan") {
    const hands = (action.moves || []).map((m, i) => `${i + 1}.${describeAction(m)}`).join(" → ");
    if (action.planKind === "dig") {
      if (action.canMatchPrior && action.matchIds?.length) {
        return `翻层可消(id${action.matchIds.join(",")})×${action.atomicCount}手：${hands}`;
      }
      const revealed = (action.revealTypes || []).join(",") || "?";
      return `多步翻层(露出id${revealed})×${action.atomicCount}手：${hands}`;
    }
    return `首层多步凑三(id${action.matchType}${
      action.clearShelves?.length ? `@架${action.clearShelves.join(",")}` : ""
    })×${action.atomicCount}手：${hands}`;
  }
  return `搬 id${action.id}：架${action.fromShelf}格${action.fromSlot} → 架${action.toShelf}格${action.toSlot}`;
}

function snapshotBoard(shelves) {
  return shelves.map((shelf, index) => {
    const front = shelf.layers[0] ? [...shelf.layers[0]] : [];
    const next = shelf.layers[1] ? [...shelf.layers[1]] : null;
    return {
      i: index,
      w: shelf.width ?? front.length ?? 3,
      behind: hasContentBehind(shelf),
      front,
      layers: next ? [front, next] : front.length ? [front] : [],
    };
  });
}

function highlightForAction(action) {
  if (!action) return null;
  if (action.type === "special") {
    return { type: "special", shelf: action.shelf, slot: action.slot, id: 999 };
  }
  if (action.type === "plan") {
    const last = action.moves?.[action.moves.length - 1];
    return last ? highlightForAction(last) : null;
  }
  return {
    type: "move",
    fromShelf: action.fromShelf,
    fromSlot: action.fromSlot,
    toShelf: action.toShelf,
    toSlot: action.toSlot,
    id: action.id,
  };
}

function applyPlan(shelves, plan) {
  for (const step of plan.moves || []) {
    if (!applyAction(shelves, step)) return false;
  }
  return true;
}

function rankGreedyActions(
  shelves,
  actions,
  random,
  topK = 5,
  enabledOps = defaultEnabledOps(),
  searchCache = null,
  boardHash = null,
) {
  // Same-step score cache: identical actions must not be re-simulated.
  const scoreCache = new Map();
  const scoreCached = (action) => {
    const key = actionKey(action);
    let hit = scoreCache.get(key);
    if (hit) return hit;
    hit = scoreActionDetailed(shelves, action, enabledOps);
    scoreCache.set(key, hit);
    return hit;
  };

  const specials = actions.filter((a) => a.type === "special");
  if (specials.length && isOpEnabled(enabledOps, "special")) {
    const ranked = specials.slice(0, topK).map((action) => ({
      action,
      ...scoreCached(action),
    }));
    const pickFrom = specials.map((action) => ({
      action,
      ...scoreCached(action),
    }));
    const chosen = pickRandom(specials, random);
    return { chosen, ranked, pickFrom };
  }

  const scarce = isRevealScarce(shelves);
  const setupCache = searchCache?.setup ?? null;
  const digCache = searchCache?.dig ?? null;

  // Score atomics first. If a 1-hand match3 already exists and exposure is not scarce,
  // skip expensive multi-step setup search — pickFrom will prefer fewer hands anyway.
  let atomPool = actions.filter((a) => a.type !== "special");
  const scoredAtom = atomPool
    .map((action) => ({
      action,
      ...scoreCached(action),
    }))
    .filter((s) => isOpEnabled(enabledOps, s.reason));
  const hasViableMatch3 = scoredAtom.some(
    (s) =>
      s.reason === "match3" &&
      !s.parts.some((p) => p.startsWith("消后无着") || p.startsWith("翻后无着")),
  );
  // Non-scarce + viable 1-hand match3: skip multi-step setup search (same pickFrom via 最少手数).
  const needSetupSearch = isOpEnabled(enabledOps, "setup3") && (scarce || !hasViableMatch3);

  const frontMatchPlans = needSetupSearch
    ? findFrontMatchPlans(shelves, scarce ? 6 : 4, enabledOps, random, setupCache, boardHash)
    : [];
  const scoredSetup = frontMatchPlans
    .map((plan) => ({
      action: plan,
      ...scoreCached(plan),
    }))
    .filter((s) => isOpEnabled(enabledOps, s.reason));
  const hasViableSetup = scoredSetup.some((s) => !s.deadly);

  let digPlans = [];
  const wantDigLayer = enabledOps.digLayer !== false;
  const wantDigMatch = enabledOps.digMatch !== false;
  const wantDigReveal = enabledOps.digReveal !== false;
  // 场上已有可走的首层凑三时先消，不拿翻层（含翻层可消）来比分。
  if (
    (wantDigMatch || wantDigReveal || wantDigLayer) &&
    !hasViableSetup &&
    !hasViableMatch3
  ) {
    digPlans = findDigRevealPlans(shelves, 4, digCache, boardHash).filter((p) => {
      const isMatch = Boolean(p.canMatchPrior && p.matchIds?.length);
      // Respect digMatch / digReveal when set; digLayer-only → allow any dig plan.
      if (wantDigMatch || wantDigReveal) {
        return isMatch ? wantDigMatch : wantDigReveal;
      }
      return wantDigLayer;
    });
  }

  const scoredDig = digPlans
    .map((plan) => ({
      action: plan,
      ...scoreCached(plan),
    }))
    .filter((s) => isOpEnabled(enabledOps, s.reason));

  const viableSetup = scoredSetup.filter((s) => !s.deadly);
  const viableMatch3 = scoredAtom.filter(
    (s) =>
      s.reason === "match3" &&
      !s.parts.some((p) => p.startsWith("消后无着") || p.startsWith("翻后无着")),
  );

  let scored;
  if (viableSetup.length || viableMatch3.length) {
    // 直接消首层三连：优先只消一架的短凑三，避免被「顺带多翻层」高分带跑。
    const singleClear = viableSetup.filter(
      (s) => (s.action.clearShelves || []).length <= 1,
    );
    const setupPool = singleClear.length ? singleClear : viableSetup;
    scored = setupPool.concat(viableMatch3);
    scored.sort((a, b) => b.score - a.score);
  } else {
    const scoredAll = scoredSetup.concat(scoredDig).concat(scoredAtom);
    const scoredLive = scoredAll.filter((s) => !s.deadly);
    scored = scoredLive.length ? scoredLive : scoredAll;
    scored.sort((a, b) => b.score - a.score);
  }

  // If filters wiped the pool, fall back to any remaining atomic moves that are still allowed.
  if (!scored.length) {
    scored = actions
      .filter((a) => a.type !== "special" || isOpEnabled(enabledOps, "special"))
      .map((action) => ({
        action,
        ...scoreCached(action),
      }))
      .filter((s) => isOpEnabled(enabledOps, s.reason));
    scored.sort((a, b) => b.score - a.score);
  }

  if (!scored.length) {
    return { chosen: null, ranked: [], pickFrom: [] };
  }

  const best = scored[0]?.score ?? -Infinity;
  let pool = scored.filter((s) => s.score === best);
  // Prefer random among 凑三组 when they tie at the top (match3 / setup3).
  const matchPool = pool.filter((s) => s.reason === "match3" || s.reason === "setup3");
  let pickFrom = matchPool.length ? matchPool : pool;
  // 同分优先更少手数（直接消，不绕路）。
  const minHands = Math.min(
    ...pickFrom.map((s) => s.action.atomicCount || (s.action.type === "plan" ? 99 : 1)),
  );
  pickFrom = pickFrom.filter(
    (s) => (s.action.atomicCount || (s.action.type === "plan" ? 99 : 1)) === minHands,
  );
  const chosen = pickRandom(
    pickFrom.map((s) => s.action),
    random,
  );

  return { chosen, ranked: scored.slice(0, topK), pickFrom };
}

export function playout(rawLevel, options = {}) {
  const strategy = options.strategy ?? "greedy";
  const maxMoves = options.maxMoves ?? 2500;
  const seed = options.seed ?? 1;
  const wantTrace = Boolean(options.trace);
  const topK = options.topK ?? 5;
  const enabledOps = normalizeEnabledOps(options.enabledOps);

  const state = createState(rawLevel);
  const shelves = state.shelves;
  const random = rng(seed);
  const itemsStart = countItems(shelves);
  const seen = new Set([hashShelves(shelves)]);
  let moves = 0;
  let logicSteps = 0;
  let loops = 0;
  let stallSteps = 0;
  let bestProgress = 0;
  let pathHash = 2166136261 >>> 0;
  const trace = wantTrace ? [] : null;

  const mixPath = (action) => {
    const key = actionKey(action);
    for (let i = 0; i < key.length; i += 1) {
      pathHash = Math.imul(pathHash ^ key.charCodeAt(i), 16777619) >>> 0;
    }
    pathHash = Math.imul(pathHash ^ (logicSteps + 1), 16777619) >>> 0;
  };

  const finish = (result) => {
    const left = result === "win" ? 0 : countItems(shelves);
    const progress = result === "win" ? 1 : itemsStart ? (itemsStart - left) / itemsStart : 0;
    const out = {
      result,
      moves,
      logicSteps,
      itemsStart,
      itemsLeft: left,
      layersLeft: result === "win" ? 0 : countLayers(shelves),
      progress,
      loops,
      seed,
      pathKey: `${result}|${moves}|${logicSteps}|${pathHash >>> 0}`,
    };
    if (trace) out.trace = trace;
    return out;
  };

  const pushTrace = ({
    used,
    detail,
    beforeBoard,
    candidates,
    skipped,
    wasPreferred,
    ranked,
    revealBefore,
  }) => {
    if (!trace || !detail) return;
    const left = countItems(shelves);
    const atomicCount = used?.type === "plan" ? used.atomicCount || used.moves?.length || 1 : 1;
    const revealAfter = estimateRevealChances(shelves);
    trace.push({
      step: logicSteps,
      atomicCount,
      movesTotal: moves,
      action: used,
      text: describeAction(used),
      score: detail.score,
      reason: detail.reason,
      parts: detail.parts,
      candidates,
      skippedLoops: skipped,
      wasPreferred,
      top: (ranked || []).map((r) => ({
        text: describeAction(r.action),
        score: r.score,
        reason: r.reason,
        selected: actionKey(r.action) === actionKey(used),
      })),
      submoves:
        used?.type === "plan"
          ? (used.moves || []).map((m, i) => ({
              i: i + 1,
              text: describeAction(m),
              highlight: highlightForAction(m),
            }))
          : null,
      progress: itemsStart ? (itemsStart - left) / itemsStart : 0,
      itemsLeft: left,
      before: beforeBoard,
      after: snapshotBoard(shelves),
      highlight: highlightForAction(used),
      revealChancesBefore: revealBefore?.chances ?? null,
      revealChances: revealAfter.chances,
      revealEmpties: revealAfter.empties,
      revealDigChances: revealAfter.digChances,
      revealMatchGroups: revealAfter.matchGroups,
      revealScarce: revealAfter.diggable > 0 && revealAfter.chances <= 2,
    });
  };

  while (true) {
    if (isWon(shelves)) return finish("win");
    const actions = listActions(shelves);
    if (isBoardFailed(shelves) || actions.length === 0) return finish("deadlock");
    if (moves >= maxMoves) return finish("limit");
    if (loops >= 80) return finish("deadlock");
    const progressNow = itemsStart ? (itemsStart - countItems(shelves)) / itemsStart : 0;
    if (progressNow > bestProgress + 1e-9) {
      bestProgress = progressNow;
      stallSteps = 0;
    } else {
      stallSteps += 1;
      if (stallSteps >= 250) return finish("deadlock");
    }

    const revealBefore = wantTrace ? estimateRevealChances(shelves) : null;

    let chosen = null;
    let ranked = [];

    if (strategy === "random") {
      const ordered = [...actions];
      for (let i = ordered.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
      chosen = ordered[0] ?? null;
      if (wantTrace) {
        ranked = ordered.slice(0, topK).map((action) => ({
          action,
          score: 0,
          reason: "random",
          parts: ["随机"],
        }));
      }

      let applied = false;
      let skipped = 0;
      for (const action of ordered) {
        if (!action) continue;
        const snapshot = cloneShelves(shelves);
        if (!applyAction(snapshot, action)) continue;
        const h = hashShelves(snapshot);
        if (seen.has(h)) {
          loops += 1;
          skipped += 1;
          continue;
        }
        const beforeBoard = wantTrace ? snapshotBoard(shelves) : null;
        const detail = wantTrace
          ? { score: 0, reason: "random", parts: skipped ? [`跳过环${skipped}`] : ["随机"] }
          : null;
        shelves.length = 0;
        shelves.push(...snapshot);
        seen.add(h);
        mixPath(action);
        moves += 1;
        logicSteps += 1;
        applied = true;
        pushTrace({
          used: action,
          detail,
          beforeBoard,
          candidates: actions.length,
          skipped,
          wasPreferred: action === chosen,
          ranked,
          revealBefore,
        });
        break;
      }
      if (!applied) return finish("deadlock");
      continue;
    }

    const ranking = rankGreedyActions(shelves, actions, random, topK, enabledOps);
    chosen = ranking.chosen;
    ranked = ranking.ranked;

    let applied = false;
    let skipped = 0;

    const tryCommit = (action, preferred) => {
      if (!action) return false;
      const snapshot = cloneShelves(shelves);
      const ok = action.type === "plan" ? applyPlan(snapshot, action) : applyAction(snapshot, action);
      if (!ok) return false;
      const h = hashShelves(snapshot);
      if (seen.has(h)) {
        loops += 1;
        skipped += 1;
        return false;
      }
      const atomicCount = action.type === "plan" ? action.atomicCount || action.moves.length : 1;
      if (moves + atomicCount > maxMoves) return false;

      const beforeBoard = wantTrace ? snapshotBoard(shelves) : null;
      let detail = null;
      if (wantTrace) {
        const fromRanked = ranked.find((r) => actionKey(r.action) === actionKey(action));
        detail = fromRanked
          ? { score: fromRanked.score, reason: fromRanked.reason, parts: [...fromRanked.parts] }
          : scoreActionDetailed(shelves, action, enabledOps);
        if (!preferred) detail.parts = [...detail.parts, "避环次选"];
        if (skipped) detail.parts.push(`跳过环${skipped}`);
      }

      shelves.length = 0;
      shelves.push(...snapshot);
      seen.add(h);
      mixPath(action);
      moves += atomicCount;
      logicSteps += 1;
      pushTrace({
        used: action,
        detail,
        beforeBoard,
        candidates: actions.length,
        skipped,
        wasPreferred: preferred,
        ranked,
        revealBefore,
      });
      return true;
    };

    if (tryCommit(chosen, true)) applied = true;
    else {
      for (const r of ranked) {
        if (chosen && actionKey(r.action) === actionKey(chosen)) continue;
        if (tryCommit(r.action, false)) {
          applied = true;
          break;
        }
      }
      if (!applied) {
        for (const action of actions) {
          if (chosen && actionKey(action) === actionKey(chosen)) continue;
          const detail = scoreActionDetailed(shelves, action, enabledOps);
          if (!isOpEnabled(enabledOps, detail.reason)) continue;
          if (tryCommit(action, false)) {
            applied = true;
            break;
          }
        }
      }
    }

    if (!applied) return finish("deadlock");
  }
}

function actionHandCount(action) {
  if (!action) return 1;
  if (action.type === "plan") return action.atomicCount || action.moves?.length || 1;
  return 1;
}

function makeForkNode(rawLevel, enabledOps) {
  const state = createState(rawLevel);
  const boardHash = hashShelves(state.shelves);
  return {
    parent: null,
    boardHash,
    shelves: state.shelves,
    moves: 0,
    logicSteps: 0,
    loops: 0,
    stallSteps: 0,
    bestProgress: 0,
    pathHash: 2166136261 >>> 0,
    trace: [],
    forkPath: [],
    forkPoints: [],
    truncatedAt: null,
  };
}

/** Loop check without copying a growing Set at every fork child. */
function pathHasBoard(node, boardHash) {
  for (let n = node; n; n = n.parent) {
    if (n.boardHash === boardHash) return true;
  }
  return false;
}

function mixPathHash(pathHash, action, logicSteps) {
  const key = actionKey(action);
  let h = pathHash >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  }
  return Math.imul(h ^ (logicSteps + 1), 16777619) >>> 0;
}

function tryApplyForkAction(node, action, detail, ranked, _revealBefore, candidates, forkMeta) {
  const snapshot = cloneShelves(node.shelves);
  const ok = action.type === "plan" ? applyPlan(snapshot, action) : applyAction(snapshot, action);
  if (!ok) return null;
  const h = hashShelves(snapshot);
  if (pathHasBoard(node, h)) return null;
  const atomicCount = actionHandCount(action);
  if (node.moves + atomicCount > forkMeta.maxMoves) return null;

  const itemsLeft = countItems(snapshot);
  const logicSteps = node.logicSteps + 1;
  const moves = node.moves + atomicCount;
  const progress = forkMeta.itemsStart
    ? (forkMeta.itemsStart - itemsLeft) / forkMeta.itemsStart
    : 0;

  // Trace / forkPath / forkPoints are append-only; slice shares prior entries.
  const next = {
    parent: node,
    boardHash: h,
    shelves: snapshot,
    moves,
    logicSteps,
    loops: node.loops,
    stallSteps: node.stallSteps,
    bestProgress: node.bestProgress,
    pathHash: mixPathHash(node.pathHash, action, node.logicSteps),
    trace: node.trace.slice(),
    forkPath: node.forkPath.slice(),
    forkPoints: node.forkPoints.slice(),
    truncatedAt: node.truncatedAt,
  };

  const parts = detail?.parts ? [...detail.parts] : [];
  if (forkMeta.forkWidth > 1) {
    parts.push(`同分分叉×${forkMeta.forkWidth}`);
  }
  // Slim trace during search: no boards / reveal stats / describe strings.
  // hydrateForkLeafTrace() fills those when the UI opens a branch.
  const chosenKey = actionKey(action);
  next.trace.push({
    step: logicSteps,
    atomicCount,
    movesTotal: moves,
    action,
    score: detail?.score ?? 0,
    reason: detail?.reason ?? "move",
    parts,
    candidates,
    skippedLoops: 0,
    wasPreferred: true,
    top: (ranked || []).slice(0, 5).map((r) => ({
      score: r.score,
      reason: r.reason,
      selected: actionKey(r.action) === chosenKey,
      action: r.action,
    })),
    progress,
    itemsLeft,
    forkWidth: forkMeta.forkWidth,
  });

  if (forkMeta.forkWidth > 1) {
    next.forkPoints.push({
      step: logicSteps,
      score: detail?.score ?? 0,
      candidates: forkMeta.forkWidth,
      chosenIndex: forkMeta.choiceIndex,
    });
    next.forkPath.push(`L${logicSteps}#${forkMeta.choiceIndex + 1}/${forkMeta.forkWidth}`);
  }

  if (progress > next.bestProgress + 1e-9) {
    next.bestProgress = progress;
    next.stallSteps = 0;
  } else {
    next.stallSteps += 1;
  }
  return next;
}

function finishForkLeaf(node, result, itemsStart, branchId) {
  const left = result === "win" ? 0 : countItems(node.shelves);
  const progress = result === "win" ? 1 : itemsStart ? (itemsStart - left) / itemsStart : 0;
  return {
    result,
    moves: node.moves,
    logicSteps: node.logicSteps,
    itemsStart,
    itemsLeft: left,
    layersLeft: result === "win" ? 0 : countLayers(node.shelves),
    progress,
    loops: node.loops,
    seed: 0,
    pathKey: `${result}|${node.moves}|${node.logicSteps}|${node.pathHash >>> 0}|${node.forkPath.join(">")}`,
    trialIndex: branchId,
    branchId,
    forkPath: node.forkPath.join(" → ") || "主路",
    deathStep: result === "win" ? null : node.logicSteps,
    forkPoints: node.forkPoints,
    truncated: Boolean(node.truncatedAt),
    truncatedAt: node.truncatedAt,
    trace: node.trace,
    slimTrace: true,
  };
}

/**
 * Fill boards / captions on a slim fork leaf trace by replaying stored actions.
 * Mutates leaf.trace in place; safe to call multiple times (no-op if already hydrated).
 */
export function hydrateForkLeafTrace(rawLevel, leaf, options = {}) {
  if (!leaf || !Array.isArray(leaf.trace) || !leaf.trace.length) return leaf;
  if (leaf.trace[0]?.before && leaf.trace[0]?.after && leaf.trace[0]?.text) {
    leaf.slimTrace = false;
    return leaf;
  }

  const shelves = createState(rawLevel).shelves;
  const itemsStart = leaf.itemsStart || countItems(shelves);

  for (const step of leaf.trace) {
    const action = step.action;
    const revealBefore = estimateRevealChances(shelves);
    const before = snapshotBoard(shelves);
    if (action) {
      if (action.type === "plan") applyPlan(shelves, action);
      else applyAction(shelves, action);
    }
    const revealAfter = estimateRevealChances(shelves);
    step.before = before;
    step.after = snapshotBoard(shelves);
    step.highlight = highlightForAction(action);
    step.text = step.text || describeAction(action);
    step.revealChancesBefore = revealBefore.chances;
    step.revealChances = revealAfter.chances;
    step.revealEmpties = revealAfter.empties;
    step.revealDigChances = revealAfter.digChances;
    step.revealMatchGroups = revealAfter.matchGroups;
    step.revealScarce = revealAfter.diggable > 0 && revealAfter.chances <= 2;
    if (action?.type === "plan") {
      step.submoves = (action.moves || []).map((m, i) => ({
        i: i + 1,
        text: describeAction(m),
        highlight: highlightForAction(m),
      }));
    }
    if (Array.isArray(step.top)) {
      step.top = step.top.map((t) => ({
        text: t.text || describeAction(t.action),
        score: t.score,
        reason: t.reason,
        selected: Boolean(t.selected),
      }));
    }
    if (step.progress == null && itemsStart) {
      step.progress = (itemsStart - countItems(shelves)) / itemsStart;
    }
  }
  leaf.slimTrace = false;
  return leaf;
}

/**
 * Single-start tree: at each step fork all top-score pickFrom actions (capped).
 * @returns {{ results: object[], truncated: boolean, exploredLeaves: number }}
 */
export function analyzeForkTree(rawLevel, options = {}) {
  const maxMoves = options.maxMoves ?? 2500;
  const maxBranches = Math.max(1, options.maxBranches ?? 64);
  const maxForkWidth = Math.max(1, options.maxForkWidth ?? 8);
  const enabledOps = normalizeEnabledOps(options.enabledOps);
  const topK = options.topK ?? 5;
  const random = rng(options.seed ?? 1);

  const root = makeForkNode(rawLevel, enabledOps);
  const itemsStart = countItems(root.shelves);
  const frontier = [root];
  const leaves = [];
  let truncated = false;
  // Transposition cache for expensive setup/dig searches across reconverging boards.
  const searchCache = { setup: new Map(), dig: new Map() };

  while (frontier.length && leaves.length < maxBranches) {
    const node = frontier.shift();
    if (isWon(node.shelves)) {
      leaves.push(finishForkLeaf(node, "win", itemsStart, leaves.length));
      continue;
    }
    const actions = listActions(node.shelves);
    if (isBoardFailed(node.shelves) || actions.length === 0) {
      leaves.push(finishForkLeaf(node, "deadlock", itemsStart, leaves.length));
      continue;
    }
    if (node.moves >= maxMoves) {
      leaves.push(finishForkLeaf(node, "limit", itemsStart, leaves.length));
      continue;
    }
    if (node.loops >= 80 || node.stallSteps >= 250) {
      leaves.push(finishForkLeaf(node, "deadlock", itemsStart, leaves.length));
      continue;
    }

    const ranking = rankGreedyActions(
      node.shelves,
      actions,
      random,
      topK,
      enabledOps,
      searchCache,
      node.boardHash,
    );
    let pickFrom = ranking.pickFrom?.length
      ? ranking.pickFrom
      : ranking.chosen
        ? [{ action: ranking.chosen, ...scoreActionDetailed(node.shelves, ranking.chosen, enabledOps) }]
        : [];

    if (!pickFrom.length) {
      leaves.push(finishForkLeaf(node, "deadlock", itemsStart, leaves.length));
      continue;
    }

    let widthTruncated = false;
    if (pickFrom.length > maxForkWidth) {
      pickFrom = pickFrom.slice(0, maxForkWidth);
      widthTruncated = true;
      truncated = true;
    }

    const forkWidth = pickFrom.length;
    const children = [];
    for (let i = 0; i < pickFrom.length; i += 1) {
      if (leaves.length + frontier.length + children.length >= maxBranches * 2) {
        truncated = true;
        break;
      }
      const entry = pickFrom[i];
      const child = tryApplyForkAction(
        node,
        entry.action,
        entry,
        ranking.ranked,
        null,
        actions.length,
        {
          maxMoves,
          itemsStart,
          forkWidth,
          choiceIndex: i,
        },
      );
      if (child) {
        if (widthTruncated && !child.truncatedAt) {
          child.truncatedAt = child.logicSteps;
        }
        children.push(child);
      }
    }

    if (!children.length) {
      // Fall back like playout: try remaining ranked / any legal action (no extra fork).
      let rescued = null;
      for (const r of ranking.ranked || []) {
        rescued = tryApplyForkAction(
          node,
          r.action,
          r,
          ranking.ranked,
          null,
          actions.length,
          { maxMoves, itemsStart, forkWidth: 1, choiceIndex: 0 },
        );
        if (rescued) break;
      }
      if (!rescued) {
        for (const action of actions) {
          const detail = scoreActionDetailed(node.shelves, action, enabledOps);
          if (!isOpEnabled(enabledOps, detail.reason)) continue;
          rescued = tryApplyForkAction(
            node,
            action,
            detail,
            ranking.ranked,
            null,
            actions.length,
            { maxMoves, itemsStart, forkWidth: 1, choiceIndex: 0 },
          );
          if (rescued) break;
        }
      }
      if (rescued) frontier.push(rescued);
      else leaves.push(finishForkLeaf(node, "deadlock", itemsStart, leaves.length));
      continue;
    }

    // Prefer expanding fewer children when near branch cap.
    const room = maxBranches - leaves.length;
    if (frontier.length + children.length > room && room > 0) {
      // Keep expanding but stop accepting new forks beyond cap by converting excess to leaves later.
      truncated = truncated || children.length > 1;
    }
    for (const child of children) {
      if (leaves.length >= maxBranches) {
        truncated = true;
        break;
      }
      frontier.push(child);
    }
  }

  // Cap: unfinished frontier nodes become truncated leaves at current position.
  while (frontier.length && leaves.length < maxBranches) {
    const node = frontier.shift();
    node.truncatedAt = node.truncatedAt ?? node.logicSteps;
    truncated = true;
    const result =
      isWon(node.shelves) ? "win" : node.moves >= maxMoves ? "limit" : "deadlock";
    leaves.push(finishForkLeaf(node, result, itemsStart, leaves.length));
  }
  if (frontier.length) truncated = true;

  return { results: leaves, truncated, exploredLeaves: leaves.length, itemsStart };
}

/**
 * Async fork analysis with UI yields + buildReport.
 */
export async function analyzeForkAsync(rawLevel, options = {}) {
  const maxBranches = Math.max(1, options.maxBranches ?? options.trials ?? 64);
  const maxForkWidth = Math.max(1, options.maxForkWidth ?? 8);
  const maxMoves = options.maxMoves ?? 2500;
  const seed0 = options.seed ?? 42;
  const enabledOps = normalizeEnabledOps(options.enabledOps);
  const onProgress = options.onProgress;
  const chunkSize = Math.max(1, options.chunkSize ?? 4);

  const state0 = createState(rawLevel);
  const profile = staticProfile(state0.shelves);
  const config = {
    mode: "fork",
    trials: maxBranches,
    maxBranches,
    maxForkWidth,
    strategy: "greedy",
    maxMoves,
    seed: seed0,
    enabledOps,
  };

  // Run tree synchronously in slices via generator-style chunking on frontier size.
  // For simplicity: compute full tree then report progress as complete (tree is usually small).
  const startedAt = performance.now();
  if (onProgress) {
    onProgress({
      done: 0,
      total: maxBranches,
      elapsedMs: 0,
      etaMs: 0,
      msPerTrial: 0,
    });
  }
  await yieldToUi();

  const tree = analyzeForkTree(rawLevel, {
    maxBranches,
    maxForkWidth,
    maxMoves,
    seed: seed0,
    enabledOps,
    topK: 5,
  });

  if (onProgress) {
    onProgress({
      done: tree.exploredLeaves,
      total: tree.exploredLeaves,
      elapsedMs: performance.now() - startedAt,
      etaMs: 0,
      msPerTrial:
        tree.exploredLeaves > 0
          ? (performance.now() - startedAt) / tree.exploredLeaves
          : 0,
    });
  }

  // Tiny yield so UI can paint progress=done before report render.
  if (chunkSize) await yieldToUi();

  const report = buildReport(tree.results, profile, {
    ...config,
    truncated: tree.truncated,
    exploredLeaves: tree.exploredLeaves,
  });
  report.summary.forkMode = true;
  report.summary.truncated = tree.truncated;
  return report;
}

export { describeAction, scoreActionDetailed, findFrontMatchPlans, findDigRevealPlans };

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function assignPatternIds(results) {
  const order = new Map();
  const counts = new Map();
  let next = 1;
  for (const r of results) {
    const key =
      r.pathKey ||
      `${r.result}|${r.moves}|${r.logicSteps}|${r.progress}|${r.loops}|${r.itemsLeft}`;
    if (!order.has(key)) order.set(key, next++);
    const id = order.get(key);
    r.patternId = id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const r of results) {
    r.patternCount = counts.get(r.patternId) || 1;
  }
  return order.size;
}

function buildReport(results, profile, config) {
  const patternTypes = assignPatternIds(results);
  const trials = results.length;
  const wins = results.filter((r) => r.result === "win");
  const deadlocks = results.filter((r) => r.result === "deadlock");
  const limits = results.filter((r) => r.result === "limit");

  const winMoves = wins.map((r) => r.moves).sort((a, b) => a - b);
  const deadMoves = deadlocks.map((r) => r.moves).sort((a, b) => a - b);
  const deadProgress = deadlocks.map((r) => r.progress);
  const allProgress = results.map((r) => r.progress);

  const buckets = [
    { label: "0–25%", min: 0, max: 0.25, count: 0 },
    { label: "25–50%", min: 0.25, max: 0.5, count: 0 },
    { label: "50–75%", min: 0.5, max: 0.75, count: 0 },
    { label: "75–99%", min: 0.75, max: 1, count: 0 },
    { label: "100%通关", min: 1, max: 1.01, count: 0 },
  ];
  for (const r of results) {
    if (r.result === "win") {
      buckets[4].count += 1;
      continue;
    }
    const b = buckets.find((x) => r.progress >= x.min && r.progress < x.max);
    if (b) b.count += 1;
    else buckets[0].count += 1;
  }

  const winRate = wins.length / trials;
  const deadlockRate = deadlocks.length / trials;
  const limitRate = limits.length / trials;

  const avgDeadProgress = mean(deadProgress);
  const earlyStuck = deadlocks.filter((r) => r.progress < 0.5).length / Math.max(1, trials);
  const movePressure = winMoves.length ? Math.min(1, mean(winMoves) / 800) : 1;
  const difficulty =
    100 *
    (0.55 * deadlockRate +
      0.2 * earlyStuck +
      0.15 * (1 - avgDeadProgress) * deadlockRate +
      0.1 * movePressure);

  let tier = "简单";
  if (difficulty >= 75) tier = "极难";
  else if (difficulty >= 55) tier = "困难";
  else if (difficulty >= 35) tier = "中等";
  else if (difficulty >= 18) tier = "偏易";

  return {
    profile,
    config,
    summary: {
      winRate,
      deadlockRate,
      limitRate,
      avgWinMoves: mean(winMoves),
      p50WinMoves: percentile(winMoves, 50),
      p90WinMoves: percentile(winMoves, 90),
      avgDeadlockMoves: mean(deadMoves),
      avgDeadlockProgress: avgDeadProgress,
      avgProgress: mean(allProgress),
      earlyStuckRate: earlyStuck,
      difficulty: Math.round(difficulty * 10) / 10,
      tier,
      patternTypes,
    },
    progressBuckets: buckets.map((b) => ({
      label: b.label,
      count: b.count,
      rate: b.count / trials,
    })),
    results,
  };
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {any} rawLevel
 * @param {{trials?:number, strategy?:string, maxMoves?:number, seed?:number, onProgress?:Function, chunkSize?:number}} options
 */
export async function analyzeLevelAsync(rawLevel, options = {}) {
  const trials = options.trials ?? 200;
  const strategy = options.strategy ?? "greedy";
  const maxMoves = options.maxMoves ?? 2500;
  const seed0 = options.seed ?? 42;
  const chunkSize = Math.max(1, options.chunkSize ?? 8);
  const onProgress = options.onProgress;
  const enabledOps = normalizeEnabledOps(options.enabledOps);

  const state0 = createState(rawLevel);
  const profile = staticProfile(state0.shelves);
  const config = {
    mode: "montecarlo",
    trials,
    strategy,
    maxMoves,
    seed: seed0,
    enabledOps,
  };

  const results = [];
  const startedAt = performance.now();

  for (let i = 0; i < trials; i += 1) {
    const seed = (seed0 + i * 9973) >>> 0;
    const result = playout(rawLevel, {
      strategy,
      maxMoves,
      seed,
      enabledOps,
    });
    result.trialIndex = i;
    results.push(result);

    const done = i + 1;
    if (onProgress) {
      const elapsedMs = performance.now() - startedAt;
      const msPerTrial = elapsedMs / done;
      const remaining = trials - done;
      onProgress({
        done,
        total: trials,
        elapsedMs,
        etaMs: remaining * msPerTrial,
        msPerTrial,
      });
    }

    // Yield often enough that Workers can flush progress and the UI stays responsive
    // when falling back to the main thread.
    if (done < trials && done % chunkSize === 0) {
      await yieldToUi();
    }
  }

  return buildReport(results, profile, config);
}

/**
 * @param {any} rawLevel
 * @param {{trials?:number, strategy?:string, maxMoves?:number, seed?:number, enabledOps?:object}} options
 */
export function analyzeLevel(rawLevel, options = {}) {
  const trials = options.trials ?? 200;
  const strategy = options.strategy ?? "greedy";
  const maxMoves = options.maxMoves ?? 2500;
  const seed0 = options.seed ?? 42;
  const enabledOps = normalizeEnabledOps(options.enabledOps);

  const state0 = createState(rawLevel);
  const profile = staticProfile(state0.shelves);

  const results = [];
  for (let i = 0; i < trials; i += 1) {
    const seed = (seed0 + i * 9973) >>> 0;
    const result = playout(rawLevel, {
      strategy,
      maxMoves,
      seed,
      enabledOps,
    });
    result.trialIndex = i;
    results.push(result);
  }

  return buildReport(results, profile, {
    trials,
    strategy,
    maxMoves,
    seed: seed0,
    enabledOps,
  });
}

export function compareStrategies(rawLevel, { trials = 100, maxMoves = 2500, seed = 7 } = {}) {
  const strategies = ["random", "greedy"];
  return strategies.map((strategy) => {
    const report = analyzeLevel(rawLevel, { trials, strategy, maxMoves, seed });
    return {
      strategy,
      winRate: report.summary.winRate,
      deadlockRate: report.summary.deadlockRate,
      avgWinMoves: report.summary.avgWinMoves,
      avgDeadlockProgress: report.summary.avgDeadlockProgress,
      difficulty: report.summary.difficulty,
      tier: report.summary.tier,
    };
  });
}
