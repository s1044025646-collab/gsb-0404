import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enumerateLargestRectangle, largestRectangleHistogram, validateHeights } from "../src/core.js";

function rect(heights: number[]) {
  const parsed = validateHeights(heights);
  const before = [...parsed.heights];
  const result = largestRectangleHistogram(parsed.heights);
  assert.deepEqual(parsed.heights, before);
  return result;
}

describe("单调栈最大矩形", () => {
  it("经典样例返回面积 10 和 [2,4)", () => {
    const result = rect([2, 1, 5, 6, 2, 3]);
    assert.deepEqual(result.rectangle, {
      left: 2,
      right: 4,
      width: 2,
      height: 5n,
      area: 10n,
    });
  });

  it("覆盖空、单柱、递增、递减、等高和零柱隔断", () => {
    assert.equal(rect([]).rectangle, null);
    assert.equal(rect([0]).rectangle, null);
    assert.deepEqual(rect([7]).rectangle?.area, 7n);
    assert.deepEqual(rect([1, 2, 3]).rectangle, { left: 1, right: 3, width: 2, height: 2n, area: 4n });
    assert.deepEqual(rect([3, 2, 1]).rectangle, { left: 0, right: 2, width: 2, height: 2n, area: 4n });
    assert.deepEqual(rect([4, 4, 4]).rectangle, { left: 0, right: 3, width: 3, height: 4n, area: 12n });
    assert.deepEqual(rect([3, 0, 3]).rectangle, { left: 0, right: 1, width: 1, height: 3n, area: 3n });
  });

  it("多个同面积答案使用较小 left 再较小 right", () => {
    const result = rect([2, 2, 0, 2, 2]);
    assert.deepEqual(result.rectangle, { left: 0, right: 2, width: 2, height: 2n, area: 4n });
  });

  it("支持超过 Number 安全整数的精确面积", () => {
    const large = "123456789012345678901234567890";
    const result = rect([large, large] as unknown as number[]);
    assert.equal(result.rectangle?.area.toString(), "246913578024691357802469135780");
  });

  it("扩大解释预算只允许展示更多步骤，不改变最终矩形", () => {
    const parsed = validateHeights([2, 1, 5, 6, 2, 3]);
    const full = largestRectangleHistogram(parsed.heights);
    const firstTwo = full.steps.slice(0, 2);
    assert.equal(firstTwo.length, 2);
    assert.equal(full.rectangle?.area, 10n);
    assert.equal(full.eventCount, full.steps.length);
  });

  it("固定随机数组与 O(n²) 枚举答案和平局规则一致", () => {
    let seed = 20261006;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const size = Math.floor(random() * 9);
      const heights = Array.from({ length: size }, () => Math.floor(random() * 6));
      const parsed = validateHeights(heights);
      const linear = largestRectangleHistogram(parsed.heights).rectangle;
      const brute = enumerateLargestRectangle(parsed.heights);
      assert.deepEqual(linear, brute, `mismatch: ${heights.join(",")}`);
      if (linear) {
        for (let index = linear.left; index < linear.right; index += 1) {
          assert.ok(parsed.heights[index] >= linear.height);
        }
        assert.equal(linear.area, linear.height * BigInt(linear.width));
      }
    }
  });

  it("拒绝负数、小数和非法十进制字符串", () => {
    assert.throws(() => validateHeights([-1]), (error: Error & { code?: string }) => error.code === "INVALID_HEIGHT");
    assert.throws(() => validateHeights([1.2]), (error: Error & { code?: string }) => error.code === "INVALID_HEIGHT");
    assert.throws(() => validateHeights(["01"]), (error: Error & { code?: string }) => error.code === "INVALID_HEIGHT");
  });
});
