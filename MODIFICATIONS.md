# CryptoQuant AI - 项目修改汇总

> 本文档记录了自 2026-06-20 以来对项目进行的所有修改。
> 生成时间：2026-06-23
> 总提交数：24 个 commits

---

## 目录

1. [项目概述](#项目概述)
2. [修改时间线（按先后顺序）](#修改时间线)
3. [按功能分类的修改](#按功能分类的修改)
4. [关键文件变更](#关键文件变更)
5. [部署相关修改](#部署相关修改)

---

## 项目概述

**CryptoQuant AI** 是一个加密货币量化交易平台，支持：
- 多交易所（OKX、Binance、Bybit、Bitget）实时行情与交易
- 自动交易引擎（影子持仓 / 模拟盘 / 实盘）
- 回测与 Walk-Forward 分析
- 风险控制（最大回撤、最大亏损、最大订单数）
- 前端基于 React + Vite，后端基于 Express + TypeScript

**部署平台**：Render.com（Docker 容器）

---

## 修改时间线

### 2026-06-22

#### Commit 1：`ef8ee5a` - 初始提交
- **描述**：项目初始提交，包含 Render Docker 部署配置
- **文件**：全量代码

---

#### Commit 2：`04fafdf` - 移除 GitHub Actions CI
- **原因**：Render 部署不需要 GitHub Actions，直接 push 即可触发部署
- **修改**：删除 `.github/workflows/` 目录

---

#### Commit 3：`e3908f9` - 修复模拟盘复选框不保存
- **问题**：设置页面的"模拟盘"复选框点击后不保存
- **原因**：保存时从 `autoTradingConfig` 重新推导值，使用的是过时的 state
- **修复**：直接使用当前的 `autoConfig` 状态，而不是重新推导

---

#### Commit 4：`6d7f5ef` - Render 兼容：运行时创建 data 目录
- **问题**：Render 容器文件系统只读，启动时无法写入 `data/` 目录
- **修复**：
  - 在 `server.ts` 启动时动态创建 `data/` 目录
  - 修复文件权限问题

---

#### Commit 5：`7a8fea6` - 修复 OKX 状态检查（演示/模拟凭证）
- **问题**：顶部的 OKX 状态指示灯只检查了实盘凭证，未检查演示/模拟凭证
- **修复**：状态检查同时考虑 `demo` 和 `paper` 类型的凭证

---

#### Commit 6：`552a9b2` - 模拟盘复选框无响应（核心修复）
- **问题**：模拟盘和影子持仓复选框点击后无响应
- **根本原因**：受控组件的状态更新被 React 的 state closure / render batching 问题阻塞（生产环境 Vite build 特有）
- **修复**：
  - 模拟盘和影子持仓复选框使用独立的 `React.useState`
  - 同步到 `autoConfig`（保存时读取正确的值）
  - 从 `autoConfig` 加载时 also 同步到本地 state

---

#### Commit 7：`c756df9` - 复选框包装器：label 改为 div
- **问题**：`label` 包裹 `checkbox` 会导致点击 label 文字时触发两次点击
- **修复**：将 `label` 改为 `div`，手动处理点击事件

---

#### Commit 8：`64979ce` - 使用环境变量凭证时跳过空凭证 POST
- **问题**：当使用环境变量 `OKX_API_KEY` 等配置凭证时，前端仍会 POST 空凭证到后端
- **修复**：检测到环境变量凭证时，跳过空的凭证写入

---

#### Commit 9：`e967b63` - 修复可靠性页面黑屏
- **问题**：访问可靠性页面时整个应用黑屏
- **原因**：`autoConfig` 为 `null` 时访问 `autoConfig.sandbox` 抛出异常
- **修复**：添加可选链 `autoConfig?.sandbox`

---

#### Commit 10：`182f74a` / `e63ffdc` - 添加 ErrorFallback 边界
- **功能**：添加 React Error Boundary 组件，防止单个组件报错导致整个应用黑屏
- **效果**：组件报错时显示友好的错误提示，而不是白屏/黑屏

---

#### Commit 11：`c6fa6e1` / `dc5e971` - 设置页面传递 sandbox/shadow 值
- **问题**：`handleSaveSettings` 有时收到 `null` 的 `autoConfig` 回调
- **修复**：从 `SettingsPage` 直接传递当前的 `sandbox` 和 `shadow` 值到保存函数

---

#### Commit 12：`adfb439` - 新增环境变量 `AUTO_TRADING_CONFIG` 兜底
- **原因**：Render 容器是临时的，文件系统写入会在部署重启后丢失
- **功能**：
  - 支持从环境变量 `AUTO_TRADING_CONFIG` 读取自动交易配置
  - 格式：`AUTO_TRADING_CONFIG={"sandbox":true,"shadow":false}`
  - 当 `appStore.json` 中无配置时，使用环境变量的值

---

#### Commit 13：`80b3ead` - 重构 `AUTO_TRADING_CONFIG` 为数字模式
- **重构**：将 `AUTO_TRADING_CONFIG` 从对象改为数字模式，更简洁
- **映射**：
  - `0` = 影子持仓（shadow）
  - `1` = 模拟盘（sandbox）
  - `2` = 实盘（live）
- **环境变量示例**：`AUTO_TRADING_CONFIG=1`

---

#### Commit 14：`d9d0793` - 日志时区修复 + UTF-8 响应头
- **问题 1**：日志记录使用 UTC 时间，中国用户看不懂
- **修复 1**：所有日志时间改为 `Asia/Shanghai` 时区
- **问题 2**：SSE 响应未显式指定 UTF-8 编码，某些客户端可能解析错误
- **修复 2**：添加 `Content-Type: text/event-stream; charset=utf-8` 响应头

---

#### Commit 15：`36e43d0` - 修复源码中文字符乱码（UTF-8 双重编码）
- **问题**：`server.ts` 中的中文字符出现乱码（如 `鎵嬪姩` 应为 `手动`）
- **原因**：文件经历了 UTF-8 双重编码（UTF-8 → 被当作 Latin-1 再编码为 UTF-8）
- **修复**：用 PowerShell 脚本重写文件为正确的 UTF-8 without BOM 编码

---

#### Commit 16：`253f4af` - 防止 autoConfig 同步覆盖用户复选框状态
- **问题**：前端定期从后端同步 `autoConfig`，会覆盖用户刚刚点击的复选框状态
- **修复**：同步时比较值是否有变化，无变化时不触发重新渲染

---

#### Commit 17：`7429b5c` - 修复 macroGate 对象写入 PersistentRiskState
- **问题**：React 报错 `#31`（无法序列化 / 深比较异常）
- **原因**：`macroGate` 对象（包含函数、循环引用）被意外写入 `PersistentRiskState`
- **修复**：在写入前排除 `macroGate` 对象

---

#### Commit 18：`e04e5da` - Walk-Forward 回测异步化（解决 Render 100s 超时）
- **问题**：Walk-Forward 回测耗时超过 100 秒，Render 的代理超时切断连接
- **修复**（大改动）：
  - 服务端：`POST /api/backtest/walk-forward` 立即返回 `202 + jobId`，回测在后台运行
  - 新增：`GET /api/backtest/walk-forward/:jobId` 轮询端点
  - 服务端超时：`server.timeout = 0`（禁用 Node.js HTTP 超时）
  - 前端：提交后每 2 秒轮询一次，最多等待 10 分钟
  - 前端：显示动画进度指示器
  - 自动清理：过期任务自动清理（每 5 分钟检查一次）

---

### 2026-06-23

#### Commit 19：`48ead9b` - OKX 杠杆设置兼容对冲模式（错误 51000）
- **问题**：OKX 账户开启对冲模式（hedge mode）后，设置杠杆报错误 `51000 posSide`
- **修复**：
  - 先尝试不带 `posSide` 设置杠杆（兼容 net 模式）
  - 若收到 OKX 错误 `51000`，则分别用 `posSide=long` 和 `posSide=short` 重试

---

#### Commit 20：`da74efc` - OKX 下单兼容跨仓保证金模式（错误 51010）
- **问题**：OKX 跨仓保证金模式账户下单时，报错误 `51010`（账户模式不匹配）
- **修复**：
  - 先尝试 `tdMode=isolated` 下单
  - 若收到 OKX 错误 `51010`，则自动用 `tdMode=cross` 重试
  - 记录账户模式检测结果，便于调试

---

#### Commit 21：`6c84d1d` - 修复第 4124 行多余闭括号（构建失败）
- **问题**：Commit `da74efc` 中，OKX 51010 跨仓重试逻辑第 4124 行多了一个 `)`，导致 TypeScript 编译失败，Render 部署失败
- **修复**：移除多余的 `)`
- **代码变更**：
  ```typescript
  // 修复前（语法错误）
  if (errMsg.includes("51010") && tdMode === "isolated")) {
  // 修复后
  if (errMsg.includes("51010") && tdMode === "isolated") {
  ```

---

#### Commit 22：`1698277` - 修复自动交易日志中文字符乱码（最终修复）
- **问题**：自动交易日志显示乱码，如：
  - `寮€濮嬫壂鎻?(瀹氭椂, ALLOW_FULL)` 应为 `开始扫描(定时, ALLOW_FULL)`
  - `褰卞瓙鎸佷粨宸插紑涓?` 应为 `影子持仓已经平仓`
- **根本原因**：`server.ts` 磁盘文件中的中文字符字节损坏（UTF-8 编码错误）
- **修复内容**：
  1. 修正 `pushAutoTradingLog` 调用中的 4 处乱码（第 5268、5630、5632、5634 行）
  2. `sanitizeAutoTradingLogEntry` 函数添加对旧日志损坏文本的处理（服务器重启时自动修复 `appStore.json` 中的旧日志）
  3. 修正第 6497 行 OKX API 错误提示中的乱码
- **影响**：新日志将正确显示中文；服务器重启后，旧日志也会被自动修复

---

## 按功能分类的修改

### 🔧 部署相关
| Commit | 描述 |
|--------|------|
| `ef8ee5a` | 初始提交，包含 Render Docker 配置 |
| `04fafdf` | 移除不需要的 GitHub Actions CI |
| `6d7f5ef` | 运行时创建 `data/` 目录（Render 兼容） |
| `adfb439` | 新增 `AUTO_TRADING_CONFIG` 环境变量兜底（应对 Render 临时文件系统） |
| `80b3ead` | 重构为数字模式 `AUTO_TRADING_CONFIG=0|1|2` |

### �前端 UI 修复
| Commit | 描述 |
|--------|------|
| `e3908f9` | 模拟盘复选框不保存 |
| `552a9b2` | 模拟盘/影子持仓复选框无响应（核心修复） |
| `c756df9` | 复选框 `label` 改为 `div` |
| `e967b63` | 可靠性页面黑屏（可选链） |
| `182f74a` | 添加 ErrorFallback 边界组件 |
| `253f4af` | 防止 autoConfig 同步覆盖用户复选框 |

### 🔌 API / 后端修复
| Commit | 描述 |
|--------|------|
| `7a8fea6` | OKX 状态检查同时考虑演示/模拟凭证 |
| `64979ce` | 使用环境变量凭证时跳过空凭证 POST |
| `d9d0793` | 日志时区改为 Asia/Shanghai + UTF-8 响应头 |
| `36e43d0` | 源码中文字符 UTF-8 双重编码修复 |
| `1698277` | 自动交易日志中文字符乱码最终修复 |

### 🤖 自动交易引擎
| Commit | 描述 |
|--------|------|
| `7429b5c` | 修复 `macroGate` 对象写入 `PersistentRiskState` |
| `c6fa6e1` | 设置页面正确传递 `sandbox/shadow` 到保存函数 |
| `1698277` | 日志中文字符修复 |

### 📊 回测功能
| Commit | 描述 |
|--------|------|
| `e04e5da` | Walk-Forward 回测异步化，解决 Render 100s 超时 |

### 🏦 交易所适配（OKX）
| Commit | 描述 |
|--------|------|
| `48ead9b` | 杠杆设置兼容对冲模式（错误 51000） |
| `da74efc` | 下单兼容跨仓保证金模式（错误 51010） |
| `6c84d1d` | 修复 51010 修复中引入的语法错误（多余 `)`） |

---

## 关键文件变更

### `server.ts`（主要后端文件）
- **变更行数**：约 500+ 行修改
- **主要变更**：
  - 添加 `sanitizeAutoTradingLogEntry` 函数（中文日志翻译 + 乱码修复）
  - 添加异步 Walk-Forward 回测任务系统
  - 修复 OKX 51000 / 51010 错误处理
  - 添加 `AUTO_TRADING_CONFIG` 环境变量读取
  - 修复 `macroGate` 对象错误写入
  - 动态创建 `data/` 目录
  - 日志时区改为 Asia/Shanghai

### `src/app/pages/SettingsPage.tsx`
- **主要变更**：
  - 模拟盘/影子持仓复选框改为独立 state
  - 修复复选框点击事件处理
  - 正确传递 `sandbox/shadow` 值到保存函数

### `src/app/api.ts`
- **主要变更**：
  - 添加 Walk-Forward 回测轮询 API 调用
  - 添加 `ErrorFallback` 边界组件

### `src/app/pages/BacktestPage.tsx`
- **主要变更**：
  - Walk-Forward 回测改为异步轮询模式
  - 添加进度动画指示器

### `src/app/hooks/useBacktest.ts`
- **主要变更**：
  - 新增 Walk-Forward 轮询 hook
  - 处理 202 响应和 jobId

### `Dockerfile`
- **主要变更**：
  - Render 部署配置
  - 移除 GitHub Actions 相关配置

### `render.yaml`
- **主要变更**：
  - Render 服务配置
  - 环境变量配置

---

## 部署相关修改

### Render.com 部署流程
1. `git push` 到 `main` 分支
2. Render 自动检测到变更，触发部署
3. Render 使用 `Dockerfile` 构建 Docker 镜像
4. 启动容器，运行 `npm start`

### 环境变量配置（Render Dashboard）
```bash
# 自动交易配置（数字模式）
AUTO_TRADING_CONFIG=1  # 0=影子持仓, 1=模拟盘, 2=实盘

# OKX 实盘凭证（可选，用于绕过文件系统存储）
OKX_API_KEY=xxx
OKX_SECRET_KEY=xxx
OKX_PASSPHRASE=xxx

# OKX 演示/模拟凭证（可选）
OKX_DEMO_API_KEY=xxx
OKX_DEMO_SECRET_KEY=xxx
OKX_DEMO_PASSPHRASE=xxx
```

### 注意事项
- Render 容器的文件系统是**临时的**，每次部署重启后会丢失本地写入
- 使用环境变量 `AUTO_TRADING_CONFIG` 可以持久化自动交易配置
- `data/` 目录在运行时动态创建，无需预先创建

---

## 已知问题与未来改进

### 待修复
- [ ] TypeScript 配置错误（`@typescript-eslint` 等）导致 `npx tsc` 报错（不影响 Vite build）
- [ ] `appStore.json` 中旧日志的乱码需要在服务端重启后才会被自动修复

### 未来改进建议
- [ ] 添加日志轮转机制（防止 `appStore.json` 过大）
- [ ] 添加健康检查端点（用于 Render 健康检查）
- [ ] 前端添加日志导出功能
- [ ] 支持更多交易所（Huobi、KuCoin 等）

---

## 贡献者

| 角色 | 名称 |
|------|------|
| 开发者 | AI Agent (WorkBuddy) |
| 报告问题 | Xox（用户） |

---

## 文档结束

> 本文档由 WorkBuddy AI 自动生成，基于 `git log` 和代码分析。
> 最后更新：2026-06-23 07:20
