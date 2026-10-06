import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { MAX_EXPORT_BYTES, MAX_INPUT_BYTES } from "../core/limits.js";
import { ValidationError } from "../core/validate.js";
import { HistogramRepository } from "../db/repository.js";

export function createApiServer(repository: HistogramRepository): Server {
  return createServer(async (request, response) => {
    try {
      await route(request, response, repository);
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  repository: HistogramRepository,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true, service: "histogram-rectangle" });
    return;
  }

  const createdMatch = path.match(/^\/sequences\/([^/]+)\/versions$/);
  if (method === "POST" && createdMatch) {
    const body = await readJson(request);
    sendJson(response, 201, repository.createAdjustedVersion(decodeId(createdMatch[1]!), body.heights));
    return;
  }

  if (method === "POST" && path === "/sequences") {
    const body = await readJson(request);
    sendJson(response, 201, repository.createSequence(body.heights));
    return;
  }

  const detailMatch = path.match(/^\/sequences\/([^/]+)\/versions\/([^/]+)$/);
  if (method === "GET" && detailMatch) {
    const sequenceId = decodeId(detailMatch[1]!);
    const version = parseVersion(detailMatch[2]!);
    const record = repository.getAnalysis(
      sequenceId,
      version,
      parseNonNegative(url.searchParams.get("stepLimit") ?? "100"),
      parseNonNegative(url.searchParams.get("stepOffset") ?? "0"),
    );
    if (!record) throw new ValidationError("NOT_FOUND", "序列或版本不存在。");
    sendJson(response, 200, record);
    return;
  }

  const answerMatch = path.match(/^\/sequences\/([^/]+)\/versions\/([^/]+)\/answer$/);
  if (method === "GET" && answerMatch) {
    const record = repository.getAnswer(
      decodeId(answerMatch[1]!),
      parseVersion(answerMatch[2]!),
      parseNonNegative(url.searchParams.get("minimumOffset") ?? "0"),
      parsePositive(url.searchParams.get("minimumLimit") ?? "100"),
    );
    if (!record) throw new ValidationError("NOT_FOUND", "序列或版本不存在。");
    sendJson(response, 200, record);
    return;
  }

  const compareMatch = path.match(/^\/sequences\/([^/]+)\/compare$/);
  if (method === "GET" && compareMatch) {
    const from = parsePositive(url.searchParams.get("from"));
    const to = parsePositive(url.searchParams.get("to"));
    sendJson(response, 200, repository.compare(decodeId(compareMatch[1]!), from, to));
    return;
  }

  const exportMatch = path.match(/^\/sequences\/([^/]+)\/export$/);
  if (method === "GET" && exportMatch) {
    const versionParam = url.searchParams.get("version") ?? "latest";
    const payload = repository.exportSequence(decodeId(exportMatch[1]!), parseVersion(versionParam));
    if (Buffer.byteLength(payload, "utf8") > MAX_EXPORT_BYTES) {
      throw new ValidationError("EXPORT_TOO_LARGE", `导出体积不能超过 ${MAX_EXPORT_BYTES} 字节。`);
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
    return;
  }

  if (method === "GET" && path === "/sequences") {
    throw new ValidationError("NOT_SUPPORTED", "请使用具体 sequenceId 查询；CLI 可通过本地数据库访问版本列表。");
  }

  throw new ValidationError("NOT_FOUND", "接口不存在。");
}

async function readJson(request: IncomingMessage): Promise<{ heights?: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) {
      throw new ValidationError("INPUT_TOO_LARGE", `请求体不能超过 ${MAX_INPUT_BYTES} 字节。`);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { heights?: unknown };
  } catch {
    throw new ValidationError("INVALID_JSON", "请求体必须是合法 JSON。");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ValidationError) {
    const status = statusForCode(error.code);
    sendJson(response, status, { error: error.code, code: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "计算失败。";
  sendJson(response, 500, { error: "COMPUTATION_FAILED", code: "COMPUTATION_FAILED", message });
}

function statusForCode(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (["INPUT_TOO_LARGE", "EXPLANATION_TOO_LARGE", "EXPORT_TOO_LARGE"].includes(code)) return 413;
  if (code === "NOT_SUPPORTED") return 405;
  return 400;
}

function decodeId(value: string): string {
  return decodeURIComponent(value);
}

function parseVersion(value: string): number | "latest" {
  if (value === "latest") return "latest";
  return parsePositive(value);
}

function parsePositive(value: string | null): number {
  if (value === null) throw new ValidationError("INVALID_PARAMETER", "缺少必填正整数参数。");
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ValidationError("INVALID_PARAMETER", `参数 ${value} 必须是正整数。`);
  }
  return number;
}

function parseNonNegative(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ValidationError("INVALID_PARAMETER", `参数 ${value} 必须是非负整数。`);
  }
  return number;
}
