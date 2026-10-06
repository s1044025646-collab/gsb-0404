# 等宽直方图最大内接矩形后端

这是一个仅包含后端的 Windows 本地项目，使用 TypeScript、Node.js 和 SQLite。它计算等宽柱形图中完全位于柱形轮廓下方的最大轴对齐矩形，并保存可复现的单调栈解释。

每根柱宽固定为 1，下标采用左闭右开区间 `[left,right)`：

- 宽度：`width = right - left`
- 高度：覆盖区间内最矮柱高度
- 面积：`area = height * width`
- 平局：面积相同时先取较小 `left`，再取较小 `right`
- 空输入或全零：返回 `hasPositiveRectangle=false`、`rectangle=null`

柱高使用十进制字符串或非负安全整数传入，内部转换为 `BigInt`；HTTP/CLI 输出超大整数时以十进制字符串表示，避免 JavaScript `Number` 精度丢失。

## 环境与构建

要求：

- Windows 本地 PowerShell
- Node.js 22+（当前开发验证 Node.js 25.5.0）
- npm
- 不需要 Docker、WSL、外部在线 API 或付费服务

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

启动脚本默认选择 `127.0.0.1` 上的空闲端口，并打印实际地址。指定端口：

```powershell
npm run cli -- serve --port 8080
```

数据库默认位于项目内 `data/histograms.sqlite`，可用环境变量替换：

```powershell
$env:HISTRECT_DB="E:\GSB\0404\A\data\custom.sqlite"
npm start
```

## CLI

```powershell
# 不入库，仅计算
npm run cli -- calculate --json '[\"2\",\"1\",\"5\",\"6\",\"2\",\"3\"]'

# 导入为 SQLite 版本
npm run cli -- import 2 1 5 6 2 3 --label classic

# 查询版本、答案、步骤、最矮柱核对位置
npm run cli -- list
npm run cli -- answer --id 1
npm run cli -- steps --id 1 --limit 20 --offset 0
npm run cli -- proof --id 1

# 用完整数组替换旧版本，创建新版本
npm run cli -- adjust --id 1 --json '[\"4\",\"4\",\"4\"]' --label equal

# 比较和导出
npm run cli -- compare --left 1 --right 2
npm run cli -- export --id 1 --out report.json

# 内置演示：经典、等高、零柱、空序列和大整数
npm run demo
```

从文件导入时，文件格式为：

```json
{ "heights": ["2", "1", "5", "6", "2", "3"] }
```

```powershell
npm run cli -- import --file input.json --label from-file
```

## HTTP API

所有响应均为 JSON。BigInt 在 HTTP JSON 中编码为十进制字符串。

### `GET /health`

返回服务状态和当前限制。

### `POST /versions`

导入柱高、计算并创建版本。

```json
{
  "label": "classic",
  "heights": ["2", "1", "5", "6", "2", "3"]
}
```

### `GET /versions?limit=100&offset=0`

按新版本优先列出版本摘要。

### `GET /versions/{id}/answer`

返回最终结果、算法版本、平局规则版本和完整步骤对象。完整步骤可能较多，建议界面只展示分页；算法始终读取并计算完整输入，不会因预算跳过柱。

### `GET /versions/{id}/steps?limit=100&offset=0`

分页返回入栈、等高合并、出栈结算和零柱隔断事件。`limit` 只影响明细展示数量。

### `GET /versions/{id}/proof?positionsLimit=100&positionsOffset=0`

返回最终矩形以及区间内所有高度等于答案高度的柱位置。这些位置证明答案高度确实由最矮柱决定；相同高度位置支持分页。

### `POST /versions/{id}/adjust`

完整替换：

```json
{ "label": "equal", "heights": ["4", "4", "4"] }
```

按补丁替换单根柱：

```json
{
  "mode": "patch",
  "patches": [{ "index": 1, "height": "9" }],
  "label": "raise-index-1"
}
```

修改不会覆盖旧版本，而是创建带 `parentId` 的新版本并完整重算。

### `GET /compare?left=1&right=2`

比较两个版本的面积、宽度和高度差异。

### `GET /versions/{id}/export?maxBytes=5000000`

导出版本、原始序列、结果、算法/平局规则版本和最矮柱核对依据。

PowerShell 示例：

```powershell
$body = @{ label = "classic"; heights = @("2","1","5","6","2","3") } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:8080/versions" -Method Post -ContentType "application/json" -Body $body
```

## 单调栈算法

维护一个高度严格递增的栈。每个栈项保存：

- `height`：仍可能向右延伸的候选高度
- `left`：该候选能够覆盖的真实连续柱最早左边界

从左到右读取柱高：

1. 当前柱高于栈顶时直接入栈，左边界为当前下标。
2. 当前柱矮于栈顶时弹出栈顶，并在当前下标结算其矩形；被弹出候选的更早左边界传给当前高度。
3. 当前高度与栈顶相等时不重复压入，保留原栈项最早左边界，保证等高连续区间最宽。
4. 当前柱为 0 时先结算所有正高度，再清空栈；0 是真实隔断，不入正高度栈。
5. 输入结束后用逻辑上的虚拟右边界 `n` 结算残留候选，但不会把哨兵写入或修改原数组。

时间复杂度为 `O(n)`：每根柱最多入栈一次、出栈一次。空间复杂度为 `O(n)`。持久化完整解释需要 `O(n)` 条事件和 `O(n)` 存储；仅最终答案计算不需要枚举区间。

## 中文步骤表：`[2,1,5,6,2,3]`

| 读到 | 操作 | 候选高度 | 左边界 | 结算区间 | 面积 | 更新最优 |
|---:|---|---:|---:|---|---:|---|
| 0，高 2 | 入栈 | 2 | 0 | - | - | 否 |
| 1，高 1 | 弹出 | 2 | 0 | [0,1) | 2 | 是 |
| 1，高 1 | 入栈，继承左边界 | 1 | 0 | - | - | 否 |
| 2，高 5 | 入栈 | 5 | 2 | - | - | 否 |
| 3，高 6 | 入栈 | 6 | 3 | - | - | 否 |
| 4，高 2 | 弹出 | 6 | 3 | [3,4) | 6 | 是 |
| 4，高 2 | 弹出 | 5 | 2 | [2,4) | 10 | 是 |
| 4，高 2 | 入栈，继承左边界 | 2 | 2 | - | - | 否 |
| 5，高 3 | 入栈 | 3 | 5 | - | - | 否 |
| 结束 | 弹出残留 | 3 | 5 | [5,6) | 3 | 否 |
| 结束 | 弹出残留 | 2 | 2 | [2,6) | 8 | 否 |
| 结束 | 弹出残留 | 1 | 0 | [0,6) | 6 | 否 |

最终答案：`[2,4)`，宽 2，高 5，面积 10。区间内最矮柱位置是 `2`。

等高示例如 `[4,4,4]`：第一个 4 入栈，后两个只合并等高左边界，末尾结算 `[0,3)`，面积 12。零柱示例如 `[3,0,3]`：下标 1 的 0 结算并隔断左侧 3，右侧 3 不能跨零扩展，因此最大面积为 3。

## SQLite 持久化

`versions` 表保存：

- 原始十进制字符串序列
- 父版本 ID、标签和创建时间
- 结果矩形、是否存在正面积矩形
- 完整可复现解释步骤
- 算法版本 `monotonic-stack-v1`
- 平局规则版本 `area-desc-left-asc-right-asc-v1`

创建版本在事务内完成校验、线性计算和最多 64 根柱的独立 `O(n²)` 枚举交叉验证；任何错误都会回滚，不覆盖已有成功版本。大于 64 根柱时仍执行输入校验和线性算法，避免把正式实现降级成区间枚举。

## 限制与错误码

默认公开限制：

- 最大柱数：`100000`
- 单个高度最大十进制位数：`78`
- 请求体：`8 MB`
- 单次解释/最矮柱分页：最多 `10000` 条
- 单次导出：最多 `5 MB`

错误通过统一 JSON 返回：

```json
{ "error": { "code": "INVALID_HEIGHT", "message": "..." } }
```

主要错误码：

| 错误码 | 含义 | HTTP 状态 |
|---|---|---:|
| `INVALID_INPUT` | 请求体或数组类型错误 | 400 |
| `INVALID_HEIGHT` | 柱高不是规范非负十进制整数 | 400 |
| `TOO_MANY_BARS` | 柱数超过上限 | 400 |
| `HEIGHT_TOO_LARGE` | 高度位数超过上限 | 400 |
| `INVALID_JSON` | JSON 无法解析 | 400 |
| `INVALID_QUERY` | 分页或查询参数非法 | 400 |
| `VERSION_NOT_FOUND` | 版本不存在 | 404 |
| `REQUEST_TOO_LARGE` | 请求体超限 | 400 |
| `EXPORT_TOO_LARGE` | 导出内容超限 | 400 |
| `COMPUTATION_FAILED` | 算法交叉校验失败，事务回滚 | 422 |
| `INTERNAL_ERROR` | 未预期服务端错误 | 500 |

无正面积不是错误：空序列和全零柱返回 200/201，结果中 `rectangle=null`，不会构造负宽度或虚构区间。

## 测试

```powershell
npm test
```

测试覆盖：

- 空序列、单柱、严格递增、严格递减、连续等高、零柱隔断
- 多个同面积答案的 `left`、`right` 平局规则
- 超过 `Number.MAX_SAFE_INTEGER` 的 BigInt 面积乘法
- 固定种子随机小数组与独立双重循环枚举全区间核对
- 覆盖柱高度不会穿过、面积乘法正确
- 解释预算只截断展示，不改变结果或跳过输入
- 原输入数组在算法后保持不变，虚拟哨兵不落回数组
- SQLite 重启持久化、非法输入事务回滚、版本调整和 HTTP API
