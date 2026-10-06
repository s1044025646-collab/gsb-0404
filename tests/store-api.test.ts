import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HistogramStore } from "../src/db.js";
import { startServer } from "../src/server.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "histrect-"));
const dbPath = path.join(tempDir, "test.sqlite");

describe("SQLite 持久化和 HTTP API", () => {
  it("成功后重启仍可查询，非法失败不覆盖旧报告", () => {
    const store = new HistogramStore(dbPath);
    const first = store.createVersion({ heights: ["2", "1", "5", "6", "2", "3"], label: "classic" });
    assert.equal(first.result.rectangle?.area, 10n);
    store.close();

    const reopened = new HistogramStore(dbPath);
    assert.throws(
      () => reopened.createVersion({ heights: ["-1"] }),
      (error: Error & { code?: string }) => error.code === "INVALID_HEIGHT",
    );
    const fetched = reopened.requireVersion(first.id);
    assert.equal(fetched.result.rectangle?.area, 10n);
    const proof = reopened.getProof(first.id);
    assert.deepEqual(proof.minimumHeightPositions.positions, [2]);
    reopened.close();
  });

  it("调整创建新版本并比较差异", () => {
    const store = new HistogramStore(dbPath);
    const first = store.requireVersion(1);
    const second = store.createVersion({ heights: ["4", "4", "4"], parentId: first.id, label: "equal" });
    const comparison = store.compare(second.id, first.id);
    assert.equal(comparison.areaDelta, 2n);
    assert.equal(second.parentId, first.id);
    store.close();
  });

  it("HTTP 创建、查询步骤和答案；预算仅截断明细", async () => {
    const running = await startServer(0, dbPath);
    after(() => running.close());
    const base = `http://127.0.0.1:${running.port}`;
    const created = await fetch(`${base}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heights: ["2", "1", "5", "6", "2", "3"], label: "api" }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const id = body.id;
    const answer = await (await fetch(`${base}/versions/${id}/answer`)).json();
    assert.equal(answer.rectangle.area, "10");
    const limited = await (await fetch(`${base}/versions/${id}/steps?limit=2`)).json();
    const larger = await (await fetch(`${base}/versions/${id}/steps?limit=3`)).json();
    assert.equal(limited.items.length, 2);
    assert.equal(larger.items.length, 3);
    assert.equal(limited.total, larger.total);
    const bad = await fetch(`${base}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heights: ["x"] }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "INVALID_HEIGHT");
  });
});
