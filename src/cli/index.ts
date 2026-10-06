#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeHistogram } from "../core/histogram.js";
import { MAX_EXPORT_BYTES } from "../core/limits.js";
import { ValidationError } from "../core/validate.js";
import { HistogramRepository } from "../db/repository.js";

const argv = process.argv.slice(2);
let cursor = 0;
while (cursor < argv.length && argv[cursor]!.startsWith("--")) {
  cursor += argv[cursor] === "--db" ? 2 : 2;
}
const command = argv[cursor] ?? "--help";
const rawArgs = argv.filter((_, index) => index !== cursor);

try {
  await main(command ?? "--help", rawArgs);
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(`错误 [${error.code}]: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : "计算失败。");
    process.exitCode = 1;
  }
}

async function main(name: string, args: string[]): Promise<void> {
  if (["--help", "-h", "help"].includes(name)) {
    printHelp();
    return;
  }

  if (name === "demo") {
    runDemo();
    return;
  }

  const dbFile = resolve(process.cwd(), option(args, "--db") ?? "data/histogram.db");
  const repository = HistogramRepository.open(dbFile);
  try {
    switch (name) {
      case "import": {
        const record = repository.createSequence(readHeights(args));
        print(record);
        break;
      }
      case "compute": {
        print(analyzeHistogram(readHeights(args)));
        break;
      }
      case "answer": {
        const record = repository.getAnswer(
          requireOption(args, "--sequence"),
          parseVersion(option(args, "--version") ?? "latest"),
          Number(option(args, "--minimum-offset") ?? 0),
          Number(option(args, "--minimum-limit") ?? 100),
        );
        if (!record) throw new ValidationError("NOT_FOUND", "序列或版本不存在。");
        print(record);
        break;
      }
      case "steps": {
        const record = repository.getAnalysis(
          requireOption(args, "--sequence"),
          parseVersion(option(args, "--version") ?? "latest"),
          Number(option(args, "--limit") ?? 100),
          Number(option(args, "--offset") ?? 0),
        );
        if (!record) throw new ValidationError("NOT_FOUND", "序列或版本不存在。");
        print(record);
        break;
      }
      case "versions": {
        print(repository.listVersions(requireOption(args, "--sequence")));
        break;
      }
      case "adjust": {
        const record = repository.createAdjustedVersion(
          requireOption(args, "--sequence"),
          readHeights(args),
        );
        print(record);
        break;
      }
      case "compare": {
        print(
          repository.compare(
            requireOption(args, "--sequence"),
            Number(requireOption(args, "--from")),
            Number(requireOption(args, "--to")),
          ),
        );
        break;
      }
      case "export": {
        const sequenceId = requireOption(args, "--sequence");
        const payload = repository.exportSequence(
          sequenceId,
          parseVersion(option(args, "--version") ?? "latest"),
        );
        if (Buffer.byteLength(payload) > MAX_EXPORT_BYTES) {
          throw new ValidationError("EXPORT_TOO_LARGE", `导出不能超过 ${MAX_EXPORT_BYTES} 字节。`);
        }
        const output = option(args, "--out");
        if (output) writeFileSync(resolve(process.cwd(), output), payload, "utf8");
        else process.stdout.write(`${payload}\n`);
        break;
      }
      default:
        throw new ValidationError("INVALID_COMMAND", `未知命令: ${name}`);
    }
  } finally {
    repository.close();
  }
}

function runDemo(): void {
  const examples: Array<[string, unknown]> = [
    ["经典 [2,1,5,6,2,3]", [2, 1, 5, 6, 2, 3]],
    ["等高柱 [2,2,2]", ["2", "2", "2"]],
    ["零柱隔断 [3,0,3]", ["3", "0", "3"]],
    ["大整数 [99999999999999999999, 99999999999999999999]", [
      "99999999999999999999",
      "99999999999999999999",
    ]],
  ];
  for (const [title, input] of examples) {
    console.log(`\n=== ${title} ===`);
    const analysis = analyzeHistogram(input);
    console.log("答案:", JSON.stringify(analysis.result, null, 2));
    console.table(
      analysis.steps.map((step) => ({
        seq: step.seq,
        类型: step.type,
        下标: step.index,
        弹出: step.poppedHeight ?? "",
        区间: step.interval ? `${step.interval[0]},${step.interval[1]}` : "",
        面积: step.area ?? "",
        更新最优: step.bestUpdated,
      })),
    );
  }
}

function readHeights(args: string[]): unknown {
  const file = option(args, "--file");
  const inline = option(args, "--heights");
  if (!file && inline === undefined) {
    throw new ValidationError("INVALID_INPUT", "请提供 --heights JSON 数组或 --file JSON 文件。");
  }
  const text = file ? readFileSync(resolve(process.cwd(), file), "utf8") : inline!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("INVALID_JSON", "柱高文件必须是 JSON 数组。");
  }
  return parsed;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireOption(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new ValidationError("INVALID_PARAMETER", `缺少参数 ${name}`);
  return value;
}

function parseVersion(value: string): number | "latest" {
  if (value === "latest") return "latest";
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ValidationError("INVALID_VERSION", "版本必须是正整数或 latest。");
  }
  return number;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  console.log(`直方图最大矩形 CLI

命令:
  demo                                      运行内置中文演示
  compute --heights '[2,1,5]'               不写库直接计算
  import --heights '[2,1,5]'                导入并持久化 v1
  answer --sequence ID [--version latest]   查询答案和区间最矮柱
  steps --sequence ID --limit 100           分页查询栈步骤
  versions --sequence ID                    查看版本
  adjust --sequence ID --heights '[...]'    调整柱高并创建新版本
  compare --sequence ID --from 1 --to 2     比较版本
  export --sequence ID [--out result.json]  导出完整可复现数据

通用:
  --db data/histogram.db                    指定项目内 SQLite 文件
  --file heights.json                       从 JSON 数组文件读取柱高
`);
}
