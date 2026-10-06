import type { AnalysisResult, RectangleResult, StackStep } from "./types.js";
import { validateHeights } from "./validate.js";

interface Candidate {
  height: bigint;
  left: number;
}

interface Best {
  left: number;
  right: number;
  height: bigint;
  area: bigint;
}

export function analyzeHistogram(input: unknown): AnalysisResult {
  const heightsText = validateHeights(input);
  const heights = heightsText.map(BigInt);
  const originalSnapshot = [...heightsText];
  const stack: Candidate[] = [];
  const steps: StackStep[] = [];
  const bestHolder: { value: Best | null } = { value: null };
  let seq = 0;

  const snapshot = () => stack.map((item) => ({ height: item.height.toString(), left: item.left }));

  const consider = (
    left: number,
    right: number,
    height: bigint,
    area: bigint,
  ): boolean => {
    if (
      area > 0n &&
      (bestHolder.value === null ||
        area > bestHolder.value.area ||
        (area === bestHolder.value.area &&
          (left < bestHolder.value.left ||
            (left === bestHolder.value.left && right < bestHolder.value.right))))
    ) {
      bestHolder.value = { left, right, height, area };
      return true;
    }
    return false;
  };

  const settle = (
    candidate: Candidate,
    right: number,
    type: "blocked-pop" | "final-pop",
    incomingHeight: bigint,
    index: number,
  ) => {
    const width = BigInt(right - candidate.left);
    const area = candidate.height * width;
    const bestUpdated = consider(candidate.left, right, candidate.height, area);
    steps.push({
      seq: seq++,
      type,
      index,
      reason:
        type === "final-pop"
          ? "到达输入末尾，残留候选不能再向右延伸。"
          : `下标 ${index} 的高度 ${incomingHeight} 不高于候选高度，候选在此闭合。`,
      incomingHeight: incomingHeight.toString(),
      poppedHeight: candidate.height.toString(),
      candidateLeft: candidate.left,
      interval: [candidate.left, right],
      area: area.toString(),
      bestUpdated,
      stackAfter: snapshot(),
    });
  };

  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index]!;
    let nextLeft = index;

    while (stack.length > 0 && stack[stack.length - 1]!.height > height) {
      const candidate = stack.pop()!;
      nextLeft = candidate.left;
      settle(candidate, index, "blocked-pop", height, index);
    }

  if (height === 0n) {
      steps.push({
        seq: seq++,
        type: "zero-barrier",
        index,
        reason: "真实零柱不能承载正高度，并隔断其左右连续区间。",
        incomingHeight: "0",
        bestUpdated: false,
        stackAfter: snapshot(),
      });
      continue;
    }

    const top = stack[stack.length - 1];
    if (top && top.height === height) {
      steps.push({
        seq: seq++,
        type: "equal-merge",
        index,
        reason: `相同高度 ${height} 合并，保留最早真实连续左边界 ${top.left}。`,
        incomingHeight: height.toString(),
        poppedHeight: height.toString(),
        candidateLeft: top.left,
        bestUpdated: false,
        stackAfter: snapshot(),
      });
      continue;
    }

    stack.push({ height, left: nextLeft });
    steps.push({
      seq: seq++,
      type: "push",
      index,
      reason:
        nextLeft === index
          ? "候选高于栈顶，开始从当前柱向右延伸。"
          : "更矮柱继承被弹出候选的真实左边界后入栈。",
      incomingHeight: height.toString(),
      candidateLeft: nextLeft,
      bestUpdated: false,
      stackAfter: snapshot(),
    });
  }

  while (stack.length > 0) {
    const candidate = stack.pop()!;
    settle(candidate, heights.length, "final-pop", 0n, heights.length);
  }

  const result: RectangleResult = bestHolder.value
    ? {
        hasPositiveRectangle: true,
        left: bestHolder.value.left,
        right: bestHolder.value.right,
        width: bestHolder.value.right - bestHolder.value.left,
        height: bestHolder.value.height.toString(),
        area: bestHolder.value.area.toString(),
      }
    : {
        hasPositiveRectangle: false,
        left: null,
        right: null,
        width: null,
        height: null,
        area: "0",
      };

  const minimumPositions =
    result.hasPositiveRectangle && result.left !== null && result.right !== null
      ? findMinimumPositions(heights, result.left, result.right)
      : [];

  return { heights: originalSnapshot, result, steps, minimumPositions };
}

export function findMinimumPositions(
  heights: bigint[],
  left: number,
  right: number,
): number[] {
  if (left >= right) return [];
  let minimum = heights[left]!;
  for (let index = left + 1; index < right; index += 1) {
    if (heights[index]! < minimum) minimum = heights[index]!;
  }
  const positions: number[] = [];
  for (let index = left; index < right; index += 1) {
    if (heights[index] === minimum) positions.push(index);
  }
  return positions;
}

export function bruteForceMaximum(input: unknown): AnalysisResult["result"] {
  const heightsText = validateHeights(input);
  const heights = heightsText.map(BigInt);
  let best: Best | null = null;

  for (let left = 0; left < heights.length; left += 1) {
    let minimum = heights[left]!;
    for (let right = left + 1; right <= heights.length; right += 1) {
      minimum = heights[right - 1]! < minimum ? heights[right - 1]! : minimum;
      const area = minimum * BigInt(right - left);
      if (
        area > 0n &&
        (best === null ||
          area > best.area ||
          (area === best.area &&
            (left < best.left || (left === best.left && right < best.right))))
      ) {
        best = { left, right, height: minimum, area };
      }
    }
  }

  return best
    ? {
        hasPositiveRectangle: true,
        left: best.left,
        right: best.right,
        width: best.right - best.left,
        height: best.height.toString(),
        area: best.area.toString(),
      }
    : {
        hasPositiveRectangle: false,
        left: null,
        right: null,
        width: null,
        height: null,
        area: "0",
      };
}
