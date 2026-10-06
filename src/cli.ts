#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { HistogramStore, defaultDbPath, parseJsonBigint } from "./db.js";
import { largestRectangleHistogram, validateHeights } from "./core.js";
import { startServer } from "./server.js";

function print(value: unknown): void {
  const seen = new WeakSet<object>();
  console.log(
    JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      },
      2,
    ),
  );
}

function parseHeights(args: string[]): unknown {
  if (args.includes("--file")) {
    const file = args[args.indexOf("--file") + 1];
    return (parseJsonBigint(fs.readFileSync(file, "utf8")) as { heights: unknown }).heights;
  }
  if (args.includes("--json")) {
    return JSON.parse(args[args.indexOf("--json") + 1]);
  }
  return args;
}

function getId(args: string[], flag: string, fallback?: number): number {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : fallback;
  const id = Number(value);
  if (!Number.isInteger(id)) throw new Error(`缺少或非法参数 ${flag}`);
  return id;
}

async function main(): Promise<void> {
  const [command = "", ...args] = process.argv.slice(2);
  const dbPath = process.env.HISTRECT_DB || defaultDbPath();

  if (command === "serve") {
    const portArg = args.indexOf("--port");
    const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
    const running = await startServer(port, dbPath);
    console.log(`服务已启动: http://127.0.0.1:${running.port}`);
    console.log(`数据库: ${path.resolve(dbPath)}`);
    const shutdown = () => {
      running.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (command === "calculate") {
    const parsed = validateHeights(parseHeights(args));
    print(largestRectangleHistogram(parsed.heights));
    return;
  }

  if (command === "import") {
    const store = new HistogramStore(dbPath);
    try {
      const labelIndex = args.indexOf("--label");
      const label = labelIndex >= 0 ? args[labelIndex + 1] : undefined;
      const record = store.createVersion({ heights: parseHeights(args), label });
      print({ id: record.id, result: record.result });
    } finally {
      store.close();
    }
    return;
  }

  if (command === "list" || command === "answer" || command === "steps" || command === "proof" || command === "export") {
    const store = new HistogramStore(dbPath);
    try {
      if (command === "list") print(store.listVersions());
      if (command === "answer") print(store.requireVersion(getId(args, "--id")).result);
      if (command === "steps") {
        const limit = getId(args, "--limit", 100);
        const offset = getId(args, "--offset", 0);
        print(store.getSteps(getId(args, "--id"), limit, offset));
      }
      if (command === "proof") print(store.getProof(getId(args, "--id")));
      if (command === "export") {
        const output = args[args.indexOf("--out") + 1];
        const text = store.exportVersion(getId(args, "--id"), 5_000_000);
        fs.writeFileSync(output, text);
        console.log(`已导出 ${path.resolve(output)}`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "adjust") {
    const store = new HistogramStore(dbPath);
    try {
      const parentId = getId(args, "--id");
      const parent = store.requireVersion(parentId);
      let heights: unknown = parent.rawHeights;
      if (args.includes("--json")) heights = JSON.parse(args[args.indexOf("--json") + 1]);
      const labelIndex = args.indexOf("--label");
      const record = store.createVersion({
        heights,
        parentId,
        label: labelIndex >= 0 ? args[labelIndex + 1] : undefined,
      });
      print({ id: record.id, parentId, result: record.result });
    } finally {
      store.close();
    }
    return;
  }

  if (command === "compare") {
    const store = new HistogramStore(dbPath);
    try {
      print(store.compare(getId(args, "--left"), getId(args, "--right")));
    } finally {
      store.close();
    }
    return;
  }

  if (command === "demo") {
    const store = new HistogramStore(dbPath);
    try {
      const cases = [
        { label: "经典 [2,1,5,6,2,3]", heights: ["2", "1", "5", "6", "2", "3"] },
        { label: "连续等高", heights: ["4", "4", "4"] },
        { label: "零柱隔断", heights: ["3", "0", "3"] },
        { label: "空序列", heights: [] },
        { label: "大整数", heights: ["1234567890123456789012345678901234567890", "1234567890123456789012345678901234567890"] },
      ];
      for (const item of cases) {
        const version = store.createVersion(item);
        console.log(`\n## ${item.label} → 版本 ${version.id}`);
        print(version.result.rectangle ?? { area: "0", positiveRectangle: false });
      }
      console.log("\n经典样例前 8 条解释:");
      print(store.getSteps(1, 8, 0));
    } finally {
      store.close();
    }
    return;
  }

  console.error(`用法:
  histrect calculate --json "[\\"2\\",\\"1\\"]"
  histrect import 2 1 5 6 2 3 --label classic
  histrect list
  histrect answer --id 1
  histrect steps --id 1 --limit 20 --offset 0
  histrect proof --id 1
  histrect adjust --id 1 --json "[\\"2\\",\\"2\\"]"
  histrect compare --left 1 --right 2
  histrect export --id 1 --out report.json
  histrect serve [--port 8080]
  histrect demo`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "CLI_ERROR";
  console.error(JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } }, null, 2));
  process.exit(1);
});
