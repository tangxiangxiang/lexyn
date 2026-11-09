# Lexyn

**Learn. Recall. Retain.**

Lexyn 是一款面向个人的词汇学习与长期记忆工具。Phase 1 提供 Library、Learn、Review、Progress 和 Settings 五个页面的应用外壳。可以在 Settings 中切换主题，偏好会保存在当前浏览器。

## 技术栈

- Web：Vue 3、严格模式 TypeScript、Vite、Vue Router、Naive UI
- 服务端：Node.js 24、Hono、better-sqlite3（WAL）
- 设备存储：Dexie、IndexedDB
- 调度基础：ts-fsrs 6，固定 FSRS-7，目标保留率 0.9
- 测试与持续集成：Vitest、Playwright、GitHub Actions

## 环境与安装

使用 Node.js **24.x** 和 npm。Windows、macOS 和 Linux 使用同一组命令。

```sh
npm ci
```

默认配置可直接使用。需要覆盖时，将 `.env.example` 复制为 `.env`。进程环境变量优先于文件中的值。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LEXYN_HOST` | `127.0.0.1` | Hono 监听地址 |
| `LEXYN_PORT` | `3000` | Hono 端口，也是 Vite 开发代理的目标端口 |
| `LEXYN_DATA_DIR` | `./data` | SQLite 数据目录。相对路径以启动时的工作目录为准 |

## 本地开发

```sh
npm run dev
```

在 Vite 输出的地址打开应用，默认是 `http://localhost:5173`。前端支持热更新，Vite 将 `/api` 请求转发给 Hono。访问 `/api/health` 可检查服务和 SQLite。

## 构建与启动

```sh
npm run build
npm start
```

从项目根目录启动。默认访问 `http://127.0.0.1:3000`，静态资源、SPA 路由和 API 由同一进程提供。SQLite 数据位于数据目录的 `lexyn.sqlite`，启动时按版本执行迁移。更换数据目录会打开另一份数据库。IndexedDB 按浏览器来源隔离，开发与生产的端口对应独立的设备存储。

## 测试

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright 使用生产构建，在端口 `4173` 启动测试服务并使用 `data/playwright` 存放测试数据库。CI 在 Ubuntu 上运行同一套检查。

## 工程结构

```text
src/
  app/           应用外壳与 Naive UI Provider
  components/    页面空状态与共享图标
  features/      Library、Learn、Review、Progress、Settings
  db/            Dexie schema 与设备偏好
  router/        路由与主导航
  styles/        设计变量与响应式布局
  ui/            主题状态和图标定义
shared/
  contracts/     HTTP 响应契约
  domain/        练习和复习事件类型
  srs/           FSRS-7 工厂与初始化测试
server/
  config/        运行配置
  db/migrations/ SQLite 迁移
  routes/        Hono API
e2e/             生产构建冒烟测试
docs/            产品与技术设计基线
.github/workflows/
```

Phase 2 的单词本与词汇模型以 [Phase 0 产品与技术架构设计](docs/phase-0-product-architecture.md) 为起点。新增存储结构时延续 SQLite 和 Dexie 的版本迁移；开放个人数据 API 前需要先确定访问控制边界。
