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
  applyAction,
  isWon,
  isBoardFailed,
  staticProfile,
  frontLayer,
  isSpecialClearId,
  hashShelves,
  hasContentBehind,
  isLayerMatched,
} from "./engine.js";

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

function quickFrontSetupScore(shelves, action, typeSet) {
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
  return score;
}

function actionKey(action) {
  if (!action) return "";
  if (action.type === "special") return `s:${action.shelf}:${action.slot}`;
  if (action.type === "plan") return `p:${(action.moves || []).map(actionKey).join(">")}`;
  return `m:${action.fromShelf}:${action.fromSlot}:${action.toShelf}:${action.toSlot}:${action.id}`;
}

/** Macro plans: 2..maxLen atomic moves that eliminate a front-visible triple. */
function findFrontMatchPlans(shelves, maxLen = 4) {
  const typeSet = frontTripleTypes(shelves);
  if (!typeSet.size) return [];

  const plans = [];
  const branchAt = [14, 10, 8, 6];

  function dfs(state, path) {
    if (path.length >= maxLen) return;
    const depth = path.length;
    const ranked = listActions(state)
      .map((a) => ({ a, s: quickFrontSetupScore(state, a, typeSet) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, branchAt[depth] ?? 6);

    for (const { a } of ranked) {
      const next = cloneShelves(state);
      if (!applyAction(next, a)) continue;
      const newPath = path.concat([a]);
      const got = matchedTypeId(shelves, next, typeSet);
      if (got != null) {
        if (newPath.length >= 2) {
          plans.push({
            type: "plan",
            moves: newPath.map((m) => ({ ...m })),
            matchType: got,
            atomicCount: newPath.length,
          });
        }
        continue;
      }
      if (newPath.length < maxLen) dfs(next, newPath);
    }
  }

  dfs(shelves, []);
  plans.sort((a, b) => a.atomicCount - b.atomicCount || a.matchType - b.matchType);
  const uniq = [];
  const seen = new Set();
  for (const p of plans) {
    const k = `${p.matchType}:${p.atomicCount}:${actionKey(p)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
    if (uniq.length >= 8) break;
  }
  return uniq;
}

function scorePlan(plan) {
  if (plan.planKind === "dig") return scoreDigPlan(plan);
  const score = 840 - plan.atomicCount * 50;
  return {
    score,
    reason: "setup3",
    parts: [`首层多步凑三(id${plan.matchType})×${plan.atomicCount}手+${score}`],
  };
}

/** Detect shelves whose front layer was cleared, exposing the next layer. */
function detectReveals(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    if (!b || !a) continue;
    if (b.layers.length <= a.layers.length) continue;
    const layer = frontLayer(a);
    const revealedIds = layer
      ? layer.filter((id) => id && !isSpecialClearId(id))
      : [];
    out.push({
      shelf: i,
      layer: layer ? [...layer] : [],
      revealedIds,
    });
  }
  return out;
}

/**
 * After a dig reveal, which types can actually be eliminated (true 翻层可消):
 * - revealed layer itself is a triple, or
 * - revealed ids + prior front counts reach ≥3, or
 * - after state already has ≥3 of a revealed type on the front.
 * Empty means reveal-only (多步翻层), not 翻层可消.
 */
function digMatchIdsWithPrior(before, after, reveals) {
  const beforeFront = countFrontTypes(before);
  const afterFront = countFrontTypes(after);
  const matchIds = new Set();

  for (const rev of reveals) {
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
 * Multi-step dig plans: keep moving from non-last-layer shelves until a lower
 * layer is exposed. Prefer reveals that can match with prior front items.
 */
function findDigRevealPlans(shelves, maxLen = 4) {
  if (!shelves.some((s) => hasContentBehind(s))) return [];

  const plans = [];
  const branchAt = [10, 8, 6, 5];

  function dfs(state, path) {
    if (plans.length >= 8) return;
    if (path.length >= maxLen) return;
    const depth = path.length;
    const ranked = digRelevantActions(state)
      .map((a) => ({ a, s: scoreDigStep(state, a) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, branchAt[depth] ?? 5);

    for (const { a } of ranked) {
      if (plans.length >= 8) break;
      const next = cloneShelves(state);
      if (!applyAction(next, a)) continue;
      const newPath = path.concat([a]);
      const reveals = detectReveals(shelves, next);
      if (reveals.length) {
        if (newPath.length >= 2) {
          const matchIds = digMatchIdsWithPrior(shelves, next, reveals);
          const canMatchPrior = matchIds.length > 0;
          plans.push({
            type: "plan",
            planKind: "dig",
            moves: newPath.map((m) => ({ ...m })),
            atomicCount: newPath.length,
            reveals,
            canMatchPrior,
            matchIds,
            revealShelf: reveals[0].shelf,
            revealTypes: [...new Set(reveals.flatMap((r) => r.revealedIds))],
          });
        }
        continue;
      }
      if (newPath.length < maxLen) dfs(next, newPath);
    }
  }

  dfs(shelves, []);
  plans.sort(
    (a, b) =>
      Number(b.canMatchPrior) - Number(a.canMatchPrior) ||
      a.atomicCount - b.atomicCount ||
      a.revealShelf - b.revealShelf,
  );
  const uniq = [];
  const seen = new Set();
  for (const p of plans) {
    const k = `${p.canMatchPrior}:${p.atomicCount}:${actionKey(p)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
    if (uniq.length >= 8) break;
  }
  return uniq;
}

function scoreDigPlan(plan) {
  const revealText = (plan.revealTypes || []).join(",") || "?";
  const matchText = (plan.matchIds || []).join(",") || revealText;
  if (plan.canMatchPrior && plan.matchIds?.length) {
    const score = 760 - plan.atomicCount * 45;
    return {
      score,
      reason: "digMatch",
      parts: [`翻层可消(id${matchText})×${plan.atomicCount}手+${score}`],
    };
  }
  const score = 400 - plan.atomicCount * 40;
  return {
    score,
    reason: "digReveal",
    parts: [`多步翻层(露出id${revealText})×${plan.atomicCount}手+${score}`],
  };
}

function scoreActionDetailed(shelves, action) {
  if (action.type === "plan") return scorePlan(action);
  if (action.type === "special") {
    return { score: 1000, reason: "special", parts: ["点999"] };
  }

  const target = shelves[action.toShelf];
  let layer = frontLayer(target);
  const width = layer?.length ?? 3;
  const willCreate = Array.from({ length: width }, (_, i) => (layer ? layer[i] : 0));
  willCreate[action.toSlot] = action.id;

  let score = 0;
  const parts = [];

  if (
    willCreate.length === 3 &&
    willCreate.every((id) => id !== 0 && id === willCreate[0]) &&
    !isSpecialClearId(willCreate[0])
  ) {
    score += 800;
    parts.push("凑三+800");
  }

  const sameOnTarget = willCreate.filter((id) => id === action.id).length;

  const src = shelves[action.fromShelf];
  if (hasContentBehind(src)) {
    const snap = cloneShelves(shelves);
    if (applyAction(snap, action)) {
      const reveals = detectReveals(shelves, snap);
      if (reveals.length) {
        const matchIds = digMatchIdsWithPrior(shelves, snap, reveals);
        const revealedIds = [...new Set(reveals.flatMap((r) => r.revealedIds))];
        if (matchIds.length) {
          score += 220;
          parts.push(`翻层可消(id${matchIds.join(",")})+220`);
        } else {
          score += 90;
          parts.push(`多步翻层(露出id${revealedIds.join(",") || "?"})+90`);
        }
      } else {
        score += 30;
        parts.push("非末层+30");
      }
    } else {
      score += 30;
      parts.push("非末层+30");
    }
  }
  if (src.width === 1) {
    score += 20;
    parts.push("单格源+20");
  }
  if (sameOnTarget === 2) {
    score += 80;
    parts.push("凑对+80");
  }
  const emptiesAfter = willCreate.filter((id) => id === 0).length;
  if (emptiesAfter > 0) {
    score += emptiesAfter * 3;
    parts.push(`留空+${emptiesAfter * 3}`);
  }

  let reason = "move";
  if (parts.some((p) => p.startsWith("凑三"))) reason = "match3";
  else if (parts.some((p) => p.startsWith("凑对"))) reason = "pair";
  else if (parts.some((p) => p.startsWith("翻层可消"))) reason = "digMatch";
  else if (parts.some((p) => p.startsWith("多步翻层"))) reason = "digReveal";
  else if (parts.some((p) => p.startsWith("非末层"))) reason = "dig";
  else if (parts.some((p) => p.startsWith("单格"))) reason = "single";

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
    return `首层多步凑三(id${action.matchType})×${action.atomicCount}手：${hands}`;
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

function rankGreedyActions(shelves, actions, random, topK = 5) {
  const specials = actions.filter((a) => a.type === "special");
  if (specials.length) {
    const chosen = pickRandom(specials, random);
    return {
      chosen,
      ranked: specials.slice(0, topK).map((action) => ({
        action,
        ...scoreActionDetailed(shelves, action),
      })),
    };
  }

  const scoredAtom = actions.map((action) => ({
    action,
    ...scoreActionDetailed(shelves, action),
  }));
  // Prefer clearing front triples before starting another dig.
  const frontMatchPlans = findFrontMatchPlans(shelves, 4);
  const digPlans =
    frontMatchPlans.length || frontTripleTypes(shelves).size
      ? []
      : findDigRevealPlans(shelves, 4);
  const scoredPlans = frontMatchPlans.concat(digPlans).map((plan) => ({
    action: plan,
    ...scorePlan(plan),
  }));
  const scored = scoredPlans.concat(scoredAtom);
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? -Infinity;
  const pool = scored.filter((s) => s.score === best);
  const chosen = pickRandom(pool.map((s) => s.action), random);

  return { chosen, ranked: scored.slice(0, topK) };
}

export function playout(rawLevel, options = {}) {
  const strategy = options.strategy ?? "greedy";
  const maxMoves = options.maxMoves ?? 2500;
  const seed = options.seed ?? 1;
  const wantTrace = Boolean(options.trace);
  const topK = options.topK ?? 5;

  const state = createState(rawLevel);
  const shelves = state.shelves;
  const random = rng(seed);
  const itemsStart = countItems(shelves);
  const seen = new Set([hashShelves(shelves)]);
  let moves = 0;
  let logicSteps = 0;
  let loops = 0;
  const trace = wantTrace ? [] : null;

  const finish = (result) => {
    const left = result === "win" ? 0 : countItems(shelves);
    const out = {
      result,
      moves,
      logicSteps,
      itemsStart,
      itemsLeft: left,
      layersLeft: result === "win" ? 0 : countLayers(shelves),
      progress: result === "win" ? 1 : itemsStart ? (itemsStart - left) / itemsStart : 0,
      loops,
      seed,
    };
    if (trace) out.trace = trace;
    return out;
  };

  const pushTrace = ({ used, detail, beforeBoard, candidates, skipped, wasPreferred, ranked }) => {
    if (!trace || !detail) return;
    const left = countItems(shelves);
    const atomicCount = used?.type === "plan" ? used.atomicCount || used.moves?.length || 1 : 1;
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
    });
  };

  while (true) {
    if (isWon(shelves)) return finish("win");
    const actions = listActions(shelves);
    if (isBoardFailed(shelves) || actions.length === 0) return finish("deadlock");
    if (moves >= maxMoves) return finish("limit");

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
        });
        break;
      }
      if (!applied) return finish("deadlock");
      continue;
    }

    const ranking = rankGreedyActions(shelves, actions, random, topK);
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
          : scoreActionDetailed(shelves, action);
        if (!preferred) detail.parts = [...detail.parts, "避环次选"];
        if (skipped) detail.parts.push(`跳过环${skipped}`);
      }

      shelves.length = 0;
      shelves.push(...snapshot);
      seen.add(h);
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
      });
      return true;
    };

    if (tryCommit(chosen, true)) applied = true;
    else {
      for (const action of actions) {
        if (chosen && actionKey(action) === actionKey(chosen)) continue;
        if (tryCommit(action, false)) {
          applied = true;
          break;
        }
      }
    }

    if (!applied) return finish("deadlock");
  }
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

function buildReport(results, profile, config) {
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

  const state0 = createState(rawLevel);
  const profile = staticProfile(state0.shelves);
  const config = { trials, strategy, maxMoves, seed: seed0 };

  const results = [];
  const startedAt = performance.now();

  for (let i = 0; i < trials; i += 1) {
    const seed = (seed0 + i * 9973) >>> 0;
    const result = playout(rawLevel, {
      strategy,
      maxMoves,
      seed,
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
 * @param {{trials?:number, strategy?:string, maxMoves?:number, seed?:number}} options
 */
export function analyzeLevel(rawLevel, options = {}) {
  const trials = options.trials ?? 200;
  const strategy = options.strategy ?? "greedy";
  const maxMoves = options.maxMoves ?? 2500;
  const seed0 = options.seed ?? 42;

  const state0 = createState(rawLevel);
  const profile = staticProfile(state0.shelves);

  const results = [];
  for (let i = 0; i < trials; i += 1) {
    const seed = (seed0 + i * 9973) >>> 0;
    const result = playout(rawLevel, {
      strategy,
      maxMoves,
      seed,
    });
    result.trialIndex = i;
    results.push(result);
  }

  return buildReport(results, profile, {
    trials,
    strategy,
    maxMoves,
    seed: seed0,
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
