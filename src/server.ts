import { resolve } from "node:path";
import { createApiServer } from "./api/http.js";
import { HistogramRepository } from "./db/repository.js";

const portArg = findArg("--port");
const dbArg = findArg("--db");
const port = portArg ? Number(portArg) : Number(process.env.PORT ?? 0);
const dbFile = resolve(
  process.cwd(),
  dbArg ?? process.env.HISTOGRAM_DB ?? "data/histogram.db",
);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("端口必须是 0 到 65535 的整数；0 表示自动选择空闲端口。");
  process.exit(2);
}

const repository = HistogramRepository.open(dbFile);
const server = createApiServer(repository);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`直方图最大矩形 API 已启动`);
  console.log(`地址: http://127.0.0.1:${actualPort}`);
  console.log(`数据库: ${dbFile}`);
});

const shutdown = () => {
  server.close(() => {
    repository.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function findArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
