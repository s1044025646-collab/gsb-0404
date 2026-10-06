import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import { HistogramStore, defaultDbPath, jsonBigint, parseJsonBigint } from "./db.js";
import { MAX_BARS, MAX_EXPLANATION_DETAIL, MAX_HEIGHT_DIGITS, validationError } from "./core.js";

const MAX_REQUEST_BYTES = 8_000_000;

function toWire(value: unknown): unknown {
  return JSON.parse(jsonBigint(value), (_key, item) => {
    if (typeof item === "string" && /^-?\d+n$/.test(item)) return item.slice(0, -1);
    return item;
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(toWire(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(validationError("REQUEST_TOO_LARGE", `请求体不能超过 ${MAX_REQUEST_BYTES} 字节`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(parseJsonBigint(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(validationError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function integerQuery(url: URL, name: string, fallback: number, max: number): number {
  const text = url.searchParams.get(name);
  if (text === null) return fallback;
  if (!/^[0-9]+$/.test(text)) throw validationError("INVALID_QUERY", `${name} 必须是非负整数`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw validationError("INVALID_QUERY", `${name} 超出范围`);
  return Math.min(value, max);
}

function statusForCode(code: string): number {
  if (code === "VERSION_NOT_FOUND") return 404;
  if (code === "COMPUTATION_FAILED") return 422;
  return 400;
}

export function chooseFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(preferred, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法获取空闲端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function createServer(dbPath = defaultDbPath()): Promise<{
  server: http.Server;
  store: HistogramStore;
}> {
  const store = new HistogramStore(dbPath);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/$/, "") || "/";

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          limits: { maxBars: MAX_BARS, maxHeightDigits: MAX_HEIGHT_DIGITS, maxRequestBytes: MAX_REQUEST_BYTES, maxExplanationDetail: MAX_EXPLANATION_DETAIL },
        });
        return;
      }

      if (request.method === "GET" && pathname === "/versions") {
        const limit = integerQuery(url, "limit", 100, 500);
        const offset = integerQuery(url, "offset", 0, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, { items: store.listVersions(limit, offset), limit, offset });
        return;
      }

      const versionMatch = pathname.match(/^\/versions\/(\d+)\/(answer|steps|proof|export)$/);
      if (request.method === "GET" && versionMatch) {
        const id = Number(versionMatch[1]);
        const resource = versionMatch[2];
        if (resource === "answer") sendJson(response, 200, store.requireVersion(id).result);
        if (resource === "steps") {
          const limit = integerQuery(url, "limit", 100, MAX_EXPLANATION_DETAIL);
          const offset = integerQuery(url, "offset", 0, Number.MAX_SAFE_INTEGER);
          sendJson(response, 200, store.getSteps(id, limit, offset));
        }
        if (resource === "proof") {
          const limit = integerQuery(url, "positionsLimit", 100, MAX_EXPLANATION_DETAIL);
          const offset = integerQuery(url, "positionsOffset", 0, Number.MAX_SAFE_INTEGER);
          sendJson(response, 200, store.getProof(id, offset, limit));
        }
        if (resource === "export") {
          const maxBytes = integerQuery(url, "maxBytes", 5_000_000, 5_000_000);
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify(toWire(parseJsonBigint(store.exportVersion(id, maxBytes)))));
        }
        return;
      }

      if (request.method === "POST" && pathname === "/versions") {
        const body = (await readJson(request)) as { heights?: unknown; label?: unknown };
        if (typeof body.label !== "undefined" && typeof body.label !== "string") {
          throw validationError("INVALID_INPUT", "label 必须是字符串");
        }
        sendJson(response, 201, store.createVersion({ heights: body.heights, label: body.label }));
        return;
      }

      const adjustMatch = pathname.match(/^\/versions\/(\d+)\/adjust$/);
      if (request.method === "POST" && adjustMatch) {
        const parentId = Number(adjustMatch[1]);
        const body = (await readJson(request)) as {
          heights?: unknown;
          label?: unknown;
          mode?: "replace" | "patch";
          patches?: Array<{ index: number; height: string | number }>;
        };
        const parent = store.requireVersion(parentId);
        let heights = parent.rawHeights;
        if ((body.mode ?? "replace") === "patch") {
          heights = [...parent.rawHeights];
          for (const patchItem of body.patches ?? []) {
            if (
              typeof patchItem !== "object" ||
              patchItem === null ||
              !Number.isInteger(patchItem.index) ||
              patchItem.index < 0 ||
              patchItem.index >= heights.length ||
              (typeof patchItem.height !== "string" &&
                !(typeof patchItem.height === "number" && Number.isSafeInteger(patchItem.height)))
            ) {
              throw validationError("INVALID_PATCH", "补丁下标越界");
            }
            heights[patchItem.index] = String(patchItem.height);
          }
        } else if (typeof body.heights !== "undefined") {
          heights = body.heights as string[];
        }
        sendJson(response, 201, store.createVersion({ heights, label: body.label as string | undefined, parentId }));
        return;
      }

      if (request.method === "GET" && pathname === "/compare") {
        const left = Number(url.searchParams.get("left"));
        const right = Number(url.searchParams.get("right"));
        if (!Number.isInteger(left) || !Number.isInteger(right)) {
          throw validationError("INVALID_QUERY", "left 和 right 必须是版本 ID");
        }
        sendJson(response, 200, store.compare(left, right));
        return;
      }

      sendError(response, 404, "NOT_FOUND", "接口不存在");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_ERROR";
      const message = error instanceof Error ? error.message : "计算失败";
      sendError(response, code === "INTERNAL_ERROR" ? 500 : statusForCode(code), code, message);
    }
  });
  return { server, store };
}

export async function startServer(portInput?: number, dbPath = defaultDbPath()): Promise<{ port: number; close: () => void }> {
  const port = await chooseFreePort(portInput ?? 0);
  const { server, store } = await createServer(dbPath);
  return await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        close: () => {
          server.close();
          store.close();
        },
      });
    });
  });
}
