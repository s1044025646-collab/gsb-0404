import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { analyzeHistogram } from "../core/histogram.js";
import {
  ALGORITHM_VERSION,
  MAX_EXPLANATION_STEPS,
  TIE_RULE_VERSION,
} from "../core/limits.js";
import type { AnalysisResult, RectangleResult, StackStep } from "../core/types.js";
import { validateHeights, ValidationError } from "../core/validate.js";

export interface VersionRecord {
  sequenceId: string;
  version: number;
  parentVersion: number | null;
  heights: string[];
  createdAt: string;
}

export interface AnalysisRecord {
  sequenceId: string;
  version: number;
  status: "success";
  heights: string[];
  result: RectangleResult;
  steps: StackStep[];
  minimumPositions: number[];
  algorithmVersion: string;
  tieRuleVersion: string;
  computedAt: string;
}

export class HistogramRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  static open(file: string): HistogramRepository {
    mkdirSync(dirname(file), { recursive: true });
    return new HistogramRepository(new DatabaseSync(file));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sequences (
        id TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        sequence_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_version INTEGER,
        heights_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (sequence_id, version),
        FOREIGN KEY (sequence_id) REFERENCES sequences(id)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        sequence_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success')),
        result_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        minimum_json TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        tie_rule_version TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (sequence_id, version),
        FOREIGN KEY (sequence_id, version) REFERENCES versions(sequence_id, version)
      );
    `);
  }

  createSequence(input: unknown): AnalysisRecord {
    const heights = validateHeights(input);
    if (this.estimateSteps(heights.length) > MAX_EXPLANATION_STEPS) {
      throw new ValidationError(
        "EXPLANATION_TOO_LARGE",
        `完整解释条数可能超过上限 ${MAX_EXPLANATION_STEPS}。`,
      );
    }

    const sequenceId = cryptoRandomId();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO sequences(id, current_version, created_at, updated_at)
           VALUES (?, 1, ?, ?)`,
        )
        .run(sequenceId, now, now);
      this.insertVersion(sequenceId, 1, null, heights, now);
      const analysis = analyzeHistogram(heights);
      this.insertAnalysis(sequenceId, 1, analysis, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAnalysis(sequenceId, 1, MAX_EXPLANATION_STEPS)!;
  }

  createAdjustedVersion(sequenceId: string, input: unknown): AnalysisRecord {
    const heights = validateHeights(input);
    if (this.estimateSteps(heights.length) > MAX_EXPLANATION_STEPS) {
      throw new ValidationError(
        "EXPLANATION_TOO_LARGE",
        `完整解释条数可能超过上限 ${MAX_EXPLANATION_STEPS}。`,
      );
    }

    const sequence = this.getSequenceRow(sequenceId);
    if (!sequence) throw new ValidationError("NOT_FOUND", "序列不存在。");
    const parentVersion = Number(sequence.current_version);
    const version = parentVersion + 1;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertVersion(sequenceId, version, parentVersion, heights, now);
      const analysis = analyzeHistogram(heights);
      this.insertAnalysis(sequenceId, version, analysis, now);
      this.db
        .prepare("UPDATE sequences SET current_version = ?, updated_at = ? WHERE id = ?")
        .run(version, now, sequenceId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAnalysis(sequenceId, version, MAX_EXPLANATION_STEPS)!;
  }

  listVersions(sequenceId: string): VersionRecord[] {
    this.requireSequence(sequenceId);
    return this.db
      .prepare(
        `SELECT sequence_id, version, parent_version, heights_json, created_at
         FROM versions WHERE sequence_id = ? ORDER BY version`,
      )
      .all(sequenceId)
      .map((row) => this.toVersionRecord(row as Record<string, unknown>));
  }

  getAnalysis(
    sequenceId: string,
    version: number | "latest",
    stepLimit = 100,
    stepOffset = 0,
  ): (AnalysisRecord & { stepTotal: number; stepLimit: number; stepOffset: number }) | null {
    const resolvedVersion = version === "latest" ? this.latestVersion(sequenceId) : version;
    if (resolvedVersion === null || !Number.isInteger(resolvedVersion) || resolvedVersion < 1) {
      throw new ValidationError("INVALID_VERSION", "版本必须是正整数或 latest。");
    }
    if (!Number.isInteger(stepLimit) || stepLimit < 0 || stepLimit > MAX_EXPLANATION_STEPS) {
      throw new ValidationError("INVALID_BUDGET", "解释预算必须是 0 到上限之间的整数。");
    }
    if (!Number.isInteger(stepOffset) || stepOffset < 0) {
      throw new ValidationError("INVALID_PAGINATION", "解释偏移必须是非负整数。");
    }

    const row = this.db
      .prepare(
        `SELECT analyses.*, versions.heights_json
         FROM analyses
         JOIN versions ON versions.sequence_id = analyses.sequence_id
          AND versions.version = analyses.version
         WHERE analyses.sequence_id = ? AND analyses.version = ?`,
      )
      .get(sequenceId, resolvedVersion) as Record<string, unknown> | undefined;
    if (!row) return null;

    const allSteps = JSON.parse(String(row.steps_json)) as StackStep[];
    return {
      ...this.toAnalysisRecord(row, allSteps, String(row.heights_json)),
      steps: allSteps.slice(stepOffset, stepOffset + stepLimit),
      stepTotal: allSteps.length,
      stepLimit,
      stepOffset,
    };
  }

  getAnswer(
    sequenceId: string,
    version: number | "latest",
    minimumOffset = 0,
    minimumLimit = 100,
  ):
    | (AnalysisRecord & {
        minimumTotal: number;
        minimumOffset: number;
        minimumLimit: number;
        steps: StackStep[];
      })
    | null {
    const record = this.getAnalysis(sequenceId, version, 0, 0);
    if (!record) return null;
    if (!Number.isInteger(minimumOffset) || minimumOffset < 0) {
      throw new ValidationError("INVALID_PAGINATION", "最矮柱偏移必须是非负整数。");
    }
    if (!Number.isInteger(minimumLimit) || minimumLimit < 1 || minimumLimit > 1000) {
      throw new ValidationError("INVALID_PAGINATION", "最矮柱每页数量必须在 1 到 1000 之间。");
    }
    return {
      ...record,
      minimumPositions: record.minimumPositions.slice(
        minimumOffset,
        minimumOffset + minimumLimit,
      ),
      minimumTotal: this.getAnalysis(sequenceId, version, 0, 0)!.minimumPositions.length,
      minimumOffset,
      minimumLimit,
    };
  }

  compare(sequenceId: string, fromVersion: number, toVersion: number) {
    const from = this.getAnalysis(sequenceId, fromVersion, 0, 0);
    const to = this.getAnalysis(sequenceId, toVersion, 0, 0);
    if (!from || !to) throw new ValidationError("NOT_FOUND", "用于比较的版本不存在。");
    return {
      sequenceId,
        from: { version: fromVersion, heights: from.heights, result: from.result },
        to: { version: toVersion, heights: to.heights, result: to.result },
      areaChanged: from.result.area !== to.result.area,
      rectangleChanged:
        from.result.left !== to.result.left ||
        from.result.right !== to.result.right ||
        from.result.height !== to.result.height,
    };
  }

  exportSequence(sequenceId: string, version: number | "latest" = "latest"): string {
    const versions = this.listVersions(sequenceId);
    const resolvedVersion =
      version === "latest" ? this.latestVersion(sequenceId) : version;
    if (resolvedVersion === null) throw new ValidationError("NOT_FOUND", "序列不存在。");
    const analysis = this.getAnalysis(sequenceId, resolvedVersion, MAX_EXPLANATION_STEPS, 0);
    if (!analysis) throw new ValidationError("NOT_FOUND", "分析结果不存在。");
    return JSON.stringify(
      {
        sequenceId,
        versions,
        requestedVersion: resolvedVersion,
        result: analysis.result,
        minimumPositions: analysis.minimumPositions,
        steps: analysis.steps,
        algorithmVersion: analysis.algorithmVersion,
        tieRuleVersion: analysis.tieRuleVersion,
      },
      null,
      2,
    );
  }

  close(): void {
    this.db.close();
  }

  private insertVersion(
    sequenceId: string,
    version: number,
    parentVersion: number | null,
    heights: string[],
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO versions(sequence_id, version, parent_version, heights_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sequenceId, version, parentVersion, JSON.stringify(heights), now);
  }

  private insertAnalysis(
    sequenceId: string,
    version: number,
    analysis: AnalysisResult,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO analyses(
          sequence_id, version, status, result_json, steps_json, minimum_json,
          algorithm_version, tie_rule_version, computed_at
         ) VALUES (?, ?, 'success', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequenceId,
        version,
        JSON.stringify(analysis.result),
        JSON.stringify(analysis.steps),
        JSON.stringify(analysis.minimumPositions),
        ALGORITHM_VERSION,
        TIE_RULE_VERSION,
        now,
      );
  }

  private estimateSteps(count: number): number {
    return count * 2 + 1;
  }

  private getSequenceRow(sequenceId: string) {
    return this.db
      .prepare("SELECT * FROM sequences WHERE id = ?")
      .get(sequenceId) as Record<string, unknown> | undefined;
  }

  private requireSequence(sequenceId: string): void {
    if (!this.getSequenceRow(sequenceId)) throw new ValidationError("NOT_FOUND", "序列不存在。");
  }

  private latestVersion(sequenceId: string): number | null {
    const row = this.getSequenceRow(sequenceId);
    return row ? Number(row.current_version) : null;
  }

  private toVersionRecord(row: Record<string, unknown>): VersionRecord {
    return {
      sequenceId: String(row.sequence_id),
      version: Number(row.version),
      parentVersion: row.parent_version === null ? null : Number(row.parent_version),
      heights: JSON.parse(String(row.heights_json)) as string[],
      createdAt: String(row.created_at),
    };
  }

  private toAnalysisRecord(
    row: Record<string, unknown>,
    steps: StackStep[],
    heightsJson: string,
  ): AnalysisRecord {
    return {
      sequenceId: String(row.sequence_id),
      version: Number(row.version),
      status: "success",
      heights: JSON.parse(heightsJson) as string[],
      result: JSON.parse(String(row.result_json)) as RectangleResult,
      steps,
      minimumPositions: JSON.parse(String(row.minimum_json)) as number[],
      algorithmVersion: String(row.algorithm_version),
      tieRuleVersion: String(row.tie_rule_version),
      computedAt: String(row.computed_at),
    };
  }
}

function cryptoRandomId(): string {
  return `seq_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}
