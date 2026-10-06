# 直方图最大矩形单调栈后端

这是一个只包含 API 与 CLI 的 Windows 本地后端，使用 TypeScript、Node.js 和 Node 内置 SQLite（`node:sqlite`）。它计算固定柱宽为 1 的等宽直方图中，完全位于柱形轮廓下的最大面积矩形。

区间使用左闭右开下标 `[left,right)`，面积为 `height * (right-left)`。多个最优矩形面积相同时，按较小 `left`、再按较小 `right` 稳定选择。

## 环境要求

- Windows 本地 PowerShell
- Node.js `22.5.0` 或更新版本（当前推荐 Node 24/25，内置 SQLite 稳定可用）
- npm
- 不需要 Docker、WSL、付费服务或外部在线 API

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

`npm start` 默认监听 `127.0.0.1` 并由系统选择空闲端口，控制台会打印实际地址。也可以指定端口和数据库：

```powershell
npm start -- --port 5173 --db data/histogram.db
```

## CLI

```powershell
# 不写库，直接计算
npm run cli -- compute --heights '[2,1,5,6,2,3]'

# 导入并持久化，输出 sequenceId 和 v1
npm run cli -- import --heights '[2,1,5,6,2,3]'

# 查询答案；将上一步输出的 seq_xxx 替换到 --sequence
npm run cli -- answer --sequence seq_xxx --version latest

# 分页查看单调栈步骤
npm run cli -- steps --sequence seq_xxx --limit 20 --offset 0

# 调整柱高，完整重算并创建新版本
npm run cli -- adjust --sequence seq_xxx --heights '[3,3,1]'

# 比较版本
npm run cli -- compare --sequence seq_xxx --from 1 --to 2

# 查看所有版本
npm run cli -- versions --sequence seq_xxx

# 导出完整序列、结果、算法版本和解释
npm run cli -- export --sequence seq_xxx --version latest --out result.json

# 中文演示
npm run demo
```

柱高也可以放在 JSON 数组文件中：

```powershell
'[2,1,5,6,2,3]' | Set-Content heights.json
npm run cli -- import --file heights.json
```

## HTTP API

所有请求和响应均为 JSON。

### 健康检查

`GET /health`

### 创建序列并计算

`POST /sequences`

```json
{
  "heights": [2, 1, 5, 6, 2, 3]
}
```

柱高可以是安全整数或十进制字符串。超过 JavaScript 安全整数时使用字符串，例如 `"123456789012345678901234567890"`。

### 创建调整后的新版本

`POST /sequences/{sequenceId}/versions`

```json
{
  "heights": [3, 3, 1]
}
```

新版本完整重算，不依赖在线动态树。旧版本和旧答案不会被覆盖。

### 查询栈步骤

`GET /sequences/{sequenceId}/versions/latest?stepLimit=100&stepOffset=0`

- `stepLimit=0` 可只取元数据和结果，不取解释明细。
- 预算只截断展示，不参与面积计算，也不会跳过输入。

### 查询答案与区间最矮柱

`GET /sequences/{sequenceId}/versions/latest/answer?minimumOffset=0&minimumLimit=100`

`minimumPositions` 是最优区间内所有达到区间最小高度的柱下标，可用于核对高度没有穿过任何覆盖柱。

### 比较版本

`GET /sequences/{sequenceId}/compare?from=1&to=2`

### 导出

`GET /sequences/{sequenceId}/export?version=latest`

## 错误码

- `INVALID_INPUT`：输入不是数组。
- `INVALID_HEIGHT`：柱高不是非负十进制整数，或位数超限。
- `INVALID_JSON`：请求体或文件不是合法 JSON。
- `INPUT_TOO_LARGE`：输入体积或柱数超限。
- `EXPLANATION_TOO_LARGE`：完整可复现解释条数超限。
- `INVALID_VERSION`、`INVALID_PARAMETER`、`INVALID_PAGINATION`、`INVALID_BUDGET`：参数错误。
- `NOT_FOUND`：序列或版本不存在。
- `EXPORT_TOO_LARGE`：导出超过大小限制。
- `COMPUTATION_FAILED`：未预期的计算失败；事务失败不会覆盖已有成功报告。

空输入或全零柱不是错误，返回面积 `0`、`hasPositiveRectangle:false`，且 `left/right/width/height` 为 `null`。

## 限制

- 最大柱数：`100000`
- 单个柱高最大位数：`78` 位十进制数
- 请求体最大：`10 MiB`
- 完整解释最大：约 `200000` 条
- 导出最大：`20 MiB`
- SQLite 文件默认位于项目内 `data/histogram.db`

## 算法

单调栈保存仍可能向右延伸的候选 `{height,left}`。从左到右读取真实柱高：

1. 当前柱矮于栈顶时，弹出栈顶并用 `[候选left, 当前下标)` 结算。
2. 被弹出候选的最早左边界传给更矮的新候选，因为中间柱都不比它矮。
3. 当前高度等于栈顶时合并到既有候选，保留最早左边界，保证等高柱不会丢失最宽区间。
4. 遇到真实零柱时，先弹出正高度候选，再保留空栈；零柱本身不入正高度栈。
5. 输入读取结束后，使用逻辑上的零高度边界结算残留候选。该边界只存在于算法控制流中，不会写回输入数组。

时间复杂度 `O(n)`，空间复杂度 `O(n)`。每根柱最多入栈一次，合并或弹出过程总计也是线性次数。另设独立 `O(n²)` 双重循环仅用于测试核对，不会用于正式结果。

## 经典示例步骤表

输入 `[2,1,5,6,2,3]`，答案为高度 `5`、区间 `[2,4)`、宽度 `2`、面积 `10`。

| 读取下标 | 高度 | 动作 | 结算区间 | 结算高度 | 面积 | 说明 |
|---:|---:|---|---|---:|---:|---|
| 0 | 2 | 入栈 | - | - | - | 候选 `{2,left=0}` |
| 1 | 1 | 弹出 2 | `[0,1)` | 2 | 2 | 当前更矮，首次最优面积 2 |
| 1 | 1 | 入栈 | - | - | - | 继承左边界 0 |
| 2 | 5 | 入栈 | - | - | - | 候选 `{5,left=2}` |
| 3 | 6 | 入栈 | - | - | - | 候选 `{6,left=3}` |
| 4 | 2 | 弹出 6 | `[3,4)` | 6 | 6 | 更新最优面积 6 |
| 4 | 2 | 弹出 5 | `[2,4)` | 5 | 10 | 更新最优面积 10 |
| 4 | 2 | 入栈 | - | - | - | 继承左边界 2 |
| 5 | 3 | 入栈 | - | - | - | 候选 `{3,left=5}` |
| 末尾 | 0 | 弹出 3 | `[5,6)` | 3 | 3 | 末尾结算，不更新 |
| 末尾 | 0 | 弹出 2 | `[2,6)` | 2 | 8 | 末尾结算，不更新 |
| 末尾 | 0 | 弹出 1 | `[0,6)` | 1 | 6 | 末尾结算，不更新 |

等高柱 `[2,2,2]` 合并为最早左边界，末尾得到 `[0,3)`、高度 `2`、面积 `6`。零柱 `[3,0,3]` 会隔断区间，两侧分别只能得到面积 `3`，不会得到高度穿过零柱的面积 `6`。

## 持久化

SQLite 保存：

- 原始十进制柱高序列
- 每个调整版本及父版本
- 成功计算结果
- 完整栈事件解释
- 最矮柱位置
- `monotonic-stack-v1` 算法版本
- `smaller-left-then-smaller-right-v1` 平局规则版本

版本、原始数据和分析结果在同一事务中提交。非法调整会回滚，因此已有成功报告仍可在重启后查询。

## 测试

```powershell
npm test
```

测试包括空序列、单柱、严格递增、严格递减、连续相等、零柱隔断、多个同面积答案、大整数面积、固定种子双重循环枚举核对、解释预算不影响答案、输入数组不被哨兵修改、事务回滚和 SQLite 持久化。
