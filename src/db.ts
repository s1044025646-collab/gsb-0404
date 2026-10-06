import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ALGORITHM_VERSION,
  AnalysisResult,
  HistogramInput,
  MAX_EXPLANATION_DETAIL,
  Rectangle,
  TIE_RULE_VERSION,
  enumerateLargestRectangle,
  largestRectangleHistogram,
  minimumHeightPositions,
  validateHeights,
  validationError,
} from "./core.js";

export interface VersionRecord {
  id: number;
  parentId: number | null;
  label: string;
  rawHeights: string[];
  heights: bigint[];
  barCount: number;
  result: AnalysisResult;
  createdAt: string;
}

export interface StepPage {
  items: AnalysisResult["steps"];
  total: number;
  offset: number;
  limit: number;
}

export interface CompareReport {
  left: VersionSummary;
  right: VersionSummary;
  areaDelta: bigint;
  widthDelta: number;
  heightDelta: bigint;
  sameRectangle: boolean;
}

export interface VersionSummary {
  id: number;
  parentId: number | null;
  label: string;
  barCount: number;
  rectangle: Rectangle | null;
  hasPositiveRectangle: boolean;
  createdAt: string;
}

function revive(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

export function jsonBigint(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item.toString()}n` : item,
  );
}

export function parseJsonBigint<T>(text: string): T {
  return JSON.parse(text, revive) as T;
}

export class HistogramStore {
  private readonly database: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.database = new Database(dbPath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        raw_heights_json TEXT NOT NULL,
        bar_count INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        tie_rule_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_versions_parent ON versions(parent_id);
      CREATE INDEX IF NOT EXISTS idx_versions_created ON versions(created_at);
    `);
  }

  createVersion(input: { heights: unknown; label?: string; parentId?: number | null }): VersionRecord {
    const parsed: HistogramInput = validateHeights(input.heights);
    const parentId = input.parentId === undefined ? null : input.parentId;
    if (parentId !== null && this.getVersion(parentId) === null) {
      throw validationError("VERSION_NOT_FOUND", `父版本 ${parentId} 不存在`);
    }
    const insert = this.database.prepare(`
      INSERT INTO versions
        (parent_id, label, raw_heights_json, bar_count, result_json, algorithm_version, tie_rule_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.database.transaction(() => {
      const result = largestRectangleHistogram(parsed.heights);
      const crossCheck = parsed.heights.length <= 64 ? enumerateLargestRectangle(parsed.heights) : null;
      const sameResult =
        (result.rectangle === null && crossCheck === null) ||
        (crossCheck === null ||
        (result.rectangle !== null &&
          crossCheck !== null &&
          result.rectangle.area === crossCheck.area &&
          result.rectangle.left === crossCheck.left &&
          result.rectangle.right === crossCheck.right));
      if (!sameResult) {
        throw validationError("COMPUTATION_FAILED", "线性算法与独立枚举校验不一致，事务回滚");
      }
      const info = insert.run(
        parentId,
        input.label?.trim() || `version-${Date.now()}`,
        jsonBigint(parsed.rawHeights),
        parsed.heights.length,
        jsonBigint(result),
        ALGORITHM_VERSION,
        TIE_RULE_VERSION,
      );
      return Number(info.lastInsertRowid);
    });
    return this.getVersion(transaction())!;
  }

  getVersion(id: number): VersionRecord | null {
    const row = this.database
      .prepare(`SELECT * FROM versions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  requireVersion(id: number): VersionRecord {
    const version = this.getVersion(id);
    if (version === null) throw validationError("VERSION_NOT_FOUND", `版本 ${id} 不存在`);
    return version;
  }

  listVersions(limit = 100, offset = 0): VersionSummary[] {
    const rows = this.database
      .prepare(`SELECT * FROM versions ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)) as Record<string, unknown>[];
    return rows.map((row) => this.summary(this.hydrate(row)));
  }

  getSteps(id: number, limit = 100, offset = 0): StepPage {
    const version = this.requireVersion(id);
    const safeLimit = Math.min(Math.max(limit, 1), MAX_EXPLANATION_DETAIL);
    const safeOffset = Math.max(offset, 0);
    return {
      items: version.result.steps.slice(safeOffset, safeOffset + safeLimit),
      total: version.result.eventCount,
      offset: safeOffset,
      limit: safeLimit,
    };
  }

  getProof(id: number, positionsOffset = 0, positionsLimit = 100) {
    const version = this.requireVersion(id);
    const rectangle = version.result.rectangle;
    if (rectangle === null) {
      return { hasPositiveRectangle: false, rectangle: null, minimumHeightPositions: { positions: [], total: 0 } };
    }
    return {
      hasPositiveRectangle: true,
      rectangle,
      minimumHeightPositions: minimumHeightPositions(version.heights, rectangle, positionsOffset, positionsLimit),
    };
  }

  compare(leftId: number, rightId: number): CompareReport {
    const left = this.requireVersion(leftId);
    const right = this.requireVersion(rightId);
    const leftRect = left.result.rectangle;
    const rightRect = right.result.rectangle;
    return {
      left: this.summary(left),
      right: this.summary(right),
      areaDelta: (leftRect?.area ?? 0n) - (rightRect?.area ?? 0n),
      widthDelta: (leftRect?.width ?? 0) - (rightRect?.width ?? 0),
      heightDelta: (leftRect?.height ?? 0n) - (rightRect?.height ?? 0n),
      sameRectangle:
        leftRect !== null &&
        rightRect !== null &&
        leftRect.left === rightRect.left &&
        leftRect.right === rightRect.right &&
        leftRect.height === rightRect.height,
    };
  }

  exportVersion(id: number, maxJsonBytes: number): string {
    const maxBytes = Math.min(Math.max(maxJsonBytes, 1), 5_000_000);
    const version = this.requireVersion(id);
    const payload = {
      exportedAt: new Date().toISOString(),
      version: this.summary(version),
      rawHeights: version.rawHeights,
      result: version.result,
      proof: this.getProof(id),
    };
    const text = jsonBigint(payload);
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw validationError("EXPORT_TOO_LARGE", "导出内容超过配置上限");
    }
    return text;
  }

  private hydrate(row: Record<string, unknown>): VersionRecord {
    const rawHeights = parseJsonBigint<string[]>(String(row.raw_heights_json));
    const result = parseJsonBigint<AnalysisResult>(String(row.result_json));
    return {
      id: Number(row.id),
      parentId: row.parent_id === null ? null : Number(row.parent_id),
      label: String(row.label),
      rawHeights,
      heights: rawHeights.map((item) => BigInt(item)),
      barCount: Number(row.bar_count),
      result,
      createdAt: String(row.created_at),
    };
  }

  private summary(version: VersionRecord): VersionSummary {
    return {
      id: version.id,
      parentId: version.parentId,
      label: version.label,
      barCount: version.barCount,
      rectangle: version.result.rectangle,
      hasPositiveRectangle: version.result.hasPositiveRectangle,
      createdAt: version.createdAt,
    };
  }
}

export function defaultDataDir(): string {
  return path.join(process.cwd(), "data");
}

export function defaultDbPath(): string {
  return path.join(defaultDataDir(), "histograms.sqlite");
}
