export const MAX_BARS = 100_000;
export const MAX_HEIGHT_DIGITS = 78;
export const MAX_EXPLANATION_DETAIL = 10_000;
export const ALGORITHM_VERSION = "monotonic-stack-v1";
export const TIE_RULE_VERSION = "area-desc-left-asc-right-asc-v1";

export interface HistogramInput {
  rawHeights: readonly string[];
  heights: bigint[];
}

export interface Rectangle {
  left: number;
  right: number;
  width: number;
  height: bigint;
  area: bigint;
}

export type StepEvent =
  | {
      type: "push";
      index: number;
      height: bigint;
      stackLeft: number;
      reason: string;
    }
  | {
      type: "pop";
      index: number;
      incomingHeight: bigint;
      poppedHeight: bigint;
      stackLeft: number;
      settledLeft: number;
      settledRight: number;
      width: number;
      area: bigint;
      bestUpdated: boolean;
      reason: string;
    }
  | {
      type: "merge_equal";
      index: number;
      height: bigint;
      retainedLeft: number;
      reason: string;
    }
  | {
      type: "zero_clear";
      index: number;
      reason: string;
    };

export interface AnalysisResult {
  hasPositiveRectangle: boolean;
  rectangle: Rectangle | null;
  steps: StepEvent[];
  eventCount: number;
  algorithmVersion: string;
  tieRuleVersion: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
}

interface StackCandidate {
  height: bigint;
  left: number;
}

export function validateHeights(value: unknown): HistogramInput {
  if (!Array.isArray(value)) {
    throw validationError("INVALID_INPUT", "heights 必须是数组");
  }
  if (value.length > MAX_BARS) {
    throw validationError("TOO_MANY_BARS", `柱数不能超过 ${MAX_BARS}`);
  }
  const rawHeights: string[] = [];
  const heights: bigint[] = [];
  value.forEach((item, index) => {
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || item < 0) {
        throw validationError("INVALID_HEIGHT", `第 ${index} 项必须是非负安全整数或十进制字符串`);
      }
      item = String(item);
    }
    if (typeof item !== "string") {
      throw validationError("INVALID_HEIGHT", `第 ${index} 项必须是十进制字符串`);
    }
    const text = item.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
      throw validationError("INVALID_HEIGHT", `第 ${index} 项不是规范十进制非负整数`);
    }
    if (text.length > MAX_HEIGHT_DIGITS) {
      throw validationError("HEIGHT_TOO_LARGE", `第 ${index} 项位数不能超过 ${MAX_HEIGHT_DIGITS}`);
    }
    rawHeights.push(text);
    heights.push(BigInt(text));
  });
  return { rawHeights, heights };
}

export function validationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function betterRectangle(candidate: Rectangle, current: Rectangle | null): boolean {
  if (current === null) return true;
  if (candidate.area > current.area) return true;
  if (candidate.area < current.area) return false;
  if (candidate.left < current.left) return true;
  if (candidate.left > current.left) return false;
  return candidate.right < current.right;
}

export function largestRectangleHistogram(heights: readonly bigint[]): AnalysisResult {
  const stack: StackCandidate[] = [];
  const steps: StepEvent[] = [];
  let best: Rectangle | null = null;

  const settle = (candidate: StackCandidate, right: number, incomingHeight: bigint, index: number) => {
    const width = right - candidate.left;
    const area = candidate.height * BigInt(width);
    const rectangle: Rectangle = {
      left: candidate.left,
      right,
      width,
      height: candidate.height,
      area,
    };
    const bestUpdated = betterRectangle(rectangle, best);
    if (bestUpdated) best = rectangle;
    steps.push({
      type: "pop",
      index,
      incomingHeight,
      poppedHeight: candidate.height,
      stackLeft: candidate.left,
      settledLeft: candidate.left,
      settledRight: right,
      width,
      area,
      bestUpdated,
      reason:
        index < heights.length
          ? `第 ${index} 根柱高 ${incomingHeight} 阻挡高度 ${candidate.height}，在 [${candidate.left},${right}) 结算`
          : `输入结束，残留候选高度 ${candidate.height} 在 [${candidate.left},${right}) 结算；虚拟右边界不写回输入`,
    });
  };

  for (let index = 0; index < heights.length; index += 1) {
    const incomingHeight = heights[index];
    if (incomingHeight === 0n) {
      while (stack.length > 0) {
        settle(stack.pop()!, index, incomingHeight, index);
      }
      steps.push({
        type: "zero_clear",
        index,
        reason: `第 ${index} 根柱为 0，不能承托正高度，连续候选在此隔断；0 不入栈`,
      });
      continue;
    }

    let inheritedLeft = index;
    while (stack.length > 0 && stack[stack.length - 1].height > incomingHeight) {
      const candidate = stack.pop()!;
      inheritedLeft = candidate.left;
      settle(candidate, index, incomingHeight, index);
    }

    if (stack.length > 0 && stack[stack.length - 1].height === incomingHeight) {
      const retained = stack[stack.length - 1];
      steps.push({
        type: "merge_equal",
        index,
        height: incomingHeight,
        retainedLeft: retained.left,
        reason: `第 ${index} 根与栈顶等高 ${incomingHeight}，保留最早左边界 ${retained.left}，避免重复且覆盖最宽区间`,
      });
    } else {
      stack.push({ height: incomingHeight, left: inheritedLeft });
      steps.push({
        type: "push",
        index,
        height: incomingHeight,
        stackLeft: inheritedLeft,
        reason: `第 ${index} 根高度 ${incomingHeight} 入栈，可从真实连续左边界 ${inheritedLeft} 向右延伸`,
      });
    }
  }

  while (stack.length > 0) {
    settle(stack.pop()!, heights.length, 0n, heights.length);
  }

  const currentBest = best as Rectangle | null;
  const finalBest = currentBest !== null && currentBest.area > 0n ? currentBest : null;
  return {
    hasPositiveRectangle: finalBest !== null,
    rectangle: finalBest,
    steps,
    eventCount: steps.length,
    algorithmVersion: ALGORITHM_VERSION,
    tieRuleVersion: TIE_RULE_VERSION,
  };
}

export function minimumHeightPositions(
  heights: readonly bigint[],
  rectangle: Rectangle,
  offset = 0,
  limit = 100,
): { positions: number[]; total: number; offset: number; limit: number } {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_EXPLANATION_DETAIL) : 100;
  const all: number[] = [];
  for (let index = rectangle.left; index < rectangle.right; index += 1) {
    if (heights[index] === rectangle.height) all.push(index);
  }
  return {
    positions: all.slice(safeOffset, safeOffset + safeLimit),
    total: all.length,
    offset: safeOffset,
    limit: safeLimit,
  };
}

export function enumerateLargestRectangle(heights: readonly bigint[]): Rectangle | null {
  let best: Rectangle | null = null;
  for (let left = 0; left < heights.length; left += 1) {
    let height = heights[left];
    for (let right = left + 1; right <= heights.length; right += 1) {
      height = height < heights[right - 1] ? height : heights[right - 1];
      if (height === 0n) continue;
      const candidate: Rectangle = {
        left,
        right,
        width: right - left,
        height,
        area: height * BigInt(right - left),
      };
      if (betterRectangle(candidate, best)) best = candidate;
    }
  }
  return best;
}
