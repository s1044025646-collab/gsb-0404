import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { analyzeHistogram, bruteForceMaximum } from "../core/histogram.js";
import { HistogramRepository } from "../db/repository.js";

test("经典示例面积为 10 且区间 [2,4)", () => {
  const analysis = analyzeHistogram([2, 1, 5, 6, 2, 3]);
  assert.deepEqual(analysis.result, {
    hasPositiveRectangle: true,
    left: 2,
    right: 4,
    width: 2,
    height: "5",
    area: "10",
  });
  assert.deepEqual(analysis.minimumPositions, [2]);
});

test("空序列和全零序列没有正面积矩形", () => {
  for (const input of [[], [0], [0, 0]]) {
    const result = analyzeHistogram(input).result;
    assert.equal(result.hasPositiveRectangle, false);
    assert.equal(result.area, "0");
    assert.equal(result.left, null);
    assert.equal(result.width, null);
  }
});

test("单柱、递增、递减和连续相等高度", () => {
  assert.deepEqual(
    analyzeHistogram(["7"]).result,
    {
      hasPositiveRectangle: true,
      left: 0,
      right: 1,
      width: 1,
      height: "7",
      area: "7",
    },
  );
  assert.equal(analyzeHistogram([1, 2, 3, 4]).result.area, "6");
  assert.equal(analyzeHistogram([4, 3, 2, 1]).result.area, "6");
  const equal = analyzeHistogram([2, 2, 2]).result;
  assert.deepEqual([equal.left, equal.right, equal.height, equal.area], [0, 3, "2", "6"]);
});

test("零柱不会把左右两侧合并", () => {
  const result = analyzeHistogram([3, 0, 3]).result;
  assert.equal(result.area, "3");
  assert.deepEqual([result.left, result.right], [0, 1]);
});

test("相同面积时优先较小 left 再优先较小 right", () => {
  const result = analyzeHistogram([1, 1, 1]).result;
  assert.deepEqual([result.left, result.right, result.area], [0, 3, "3"]);
  const tie = analyzeHistogram([2, 0, 2]).result;
  assert.deepEqual([tie.left, tie.right, tie.area], [0, 1, "2"]);
});

test("BigInt 面积超过 Number 安全整数仍精确", () => {
  const height = "123456789012345678901234567890";
  const result = analyzeHistogram([height, height, height]).result;
  assert.equal(result.height, height);
  assert.equal(result.area, "370370367037037036703703703670");
  assert.ok(BigInt(result.area) > BigInt(Number.MAX_SAFE_INTEGER));
});

test("固定种子小数组与独立双重循环枚举一致", () => {
  const inputs = deterministicCases();
  for (const input of inputs) {
    const linear = analyzeHistogram(input).result;
    const brute = bruteForceMaximum(input);
    assert.deepEqual(linear, brute, JSON.stringify(input));
    if (linear.hasPositiveRectangle && linear.left !== null && linear.right !== null) {
      const claimedHeight = BigInt(linear.height!);
      for (let index = linear.left; index < linear.right; index += 1) {
        assert.ok(BigInt(input[index]!) >= claimedHeight);
      }
      assert.equal(
        claimedHeight * BigInt(linear.right - linear.left),
        BigInt(linear.area),
      );
    }
  }
});

test("解释预算不改变最终答案，哨兵不修改输入数组", () => {
  const input = [2, 1, 5, 6, 2, 3, 0, 4, 4];
  const snapshot = [...input];
  const full = analyzeHistogram(input);
  const limited = analyzeHistogram(input);
  limited.steps.length = 0;
  assert.deepEqual(full.result, bruteForceMaximum(input));
  assert.deepEqual(input, snapshot);
  assert.ok(full.steps.some((step) => step.bestUpdated));
});

test("SQLite 支持版本、事务失败回滚和重启持久化", () => {
  const dir = mkdtempSync(join(tmpdir(), "histogram-test-"));
  const dbPath = join(dir, "test.db");
  const repository = HistogramRepository.open(dbPath);
  const first = repository.createSequence([2, 1, 5, 6, 2, 3]);
  assert.equal(first.result.area, "10");

  repository.createAdjustedVersion(first.sequenceId, [3, 3, 1]);
  assert.throws(() => repository.createAdjustedVersion(first.sequenceId, ["bad"]));
  assert.throws(() => {
    repository["db"].exec("BEGIN IMMEDIATE");
    try {
      repository["db"]
        .prepare(
          `INSERT INTO versions(sequence_id, version, parent_version, heights_json, created_at)
           VALUES (?, 3, 2, '[9]', ?)`,
        )
        .run(first.sequenceId, new Date().toISOString());
      throw new Error("FORCE_ROLLBACK");
    } finally {
      repository["db"].exec("ROLLBACK");
    }
  }, /FORCE_ROLLBACK/);
  const versions = repository.listVersions(first.sequenceId);
  assert.deepEqual(versions.map((item) => item.version), [1, 2]);

  const latest = repository.getAnswer(first.sequenceId, "latest")!;
  assert.equal(latest.version, 2);
  assert.equal(latest.result.area, "6");
  repository.close();

  const reopened = HistogramRepository.open(dbPath);
  const old = reopened.getAnswer(first.sequenceId, 1)!;
  assert.equal(old.result.area, "10");
  assert.equal(old.algorithmVersion, "monotonic-stack-v1");
  assert.equal(old.tieRuleVersion, "smaller-left-then-smaller-right-v1");
  reopened.close();

  after(() => rmSync(dir, { recursive: true, force: true }));
});

test("非法输入返回明确错误", () => {
  assert.throws(
    () => analyzeHistogram([-1]),
    (error: unknown) => error instanceof Error && error.name === "ValidationError",
  );
  assert.throws(
    () => analyzeHistogram(["1.5"]),
    (error: unknown) => error instanceof Error && error.name === "ValidationError",
  );
  assert.throws(
    () => analyzeHistogram({}),
    (error: unknown) => error instanceof Error && error.name === "ValidationError",
  );
});

function deterministicCases(): string[][] {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: 80 }, (_, caseIndex) =>
    Array.from({ length: 2 + (caseIndex % 7) }, () =>
      Math.floor(random() * 6).toString(),
    ),
  );
}
