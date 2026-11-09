# Lexyn

**Learn. Recall. Retain.**

Lexyn 是一款面向个人的词汇学习与长期记忆工具。Phase 2 的 Library 可以管理单词本和词条，导入 TXT / CSV 并导出 JSON。Settings 中的主题偏好也保存在当前浏览器。

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

## 使用 Library

1. 在 **Library** 点 **New deck**，填写名称与可选描述。点单词本名称进入详情。
2. 点 **Add word** 添加词条，或点 **Import words** 批量导入。释义可以留空，之后通过 **Needs meaning** 找到待完善的词。
3. 搜索框支持英文词汇和中文释义的部分匹配。用 **Removed** 恢复移除的词条，用 **Archived decks** 恢复归档的单词本。词条恢复时若已有同名活动词条，会提示冲突。

导入文件使用 UTF-8，可带 BOM。每个文件最多 5 MiB、10,000 条数据记录。TXT 支持每行一个词或词组，也支持英文和释义之间使用一个 Tab。可以在预览中手动指定格式。CSV 使用逗号分隔，首行是表头。将源列映射到 `term` 和 `meaning`，后者允许空值。还可以映射 `phonetic`、`example` 和 `note`。CSV 支持字段内逗号、转义双引号和换行。

```csv
term,meaning,example
copy-on-write,写时复制,"This uses copy-on-write, a common optimization."
WAL,,
```

确认前可查看有效行、重复行、无效行与缺失释义数。重复比较按单词本进行，对词汇做 NFC 规范化、去除首尾空白并统一大小写。文件内保留第一条有效记录。已有词条默认跳过，显式选择覆盖时保留原 ID，并仅修改映射到的字段。无效记录会列在预览中并跳过。文件编码、CSV 结构或文件限制有问题时会阻止导入。专业词汇、缩写和词组可以直接添加。

**Export library** 下载全部单词本、词条和学习历史，包括归档单词本、已移除词条及其练习记录。详情中的 **Export deck** 只导出当前单词本及其词条和练习记录。JSON 格式为 `lexyn-library` v2，包含每日新词设置；活动会话属于设备私有状态，不导出。JSON 恢复安排在后续阶段。

## 使用 Learn

1. 在 Library 单词本详情中选择 **Start learning**，或从 Learn 首页选择活动单词本。
2. 每日新词默认 10 个，Settings 中可设为 1–100。额度按当前浏览器本地日期、跨全部单词本统计。当天完成首次练习的词计入额度；跳过不计入。额度用完后仍可练习已完成首次学习的旧词。
3. **Copy** 显示英文词、释义、音标和可用例句；**Dictation** 隐藏英文词与例句，使用设备英语语音朗读。提交后显示拼写反馈，错误后可改正重试。
4. Learn 会自动保存队列位置。离开页面或刷新后可继续活动会话；使用暂停/结束操作返回 Learn 首页后，也可以继续或放弃会话。放弃不会删除已保存的练习历史。

学习数据保存在当前浏览器来源的 IndexedDB（Dexie v3）：`practice_events` 保存不可变练习结果，`learn_progress` 保存首次完成时间与次数，`learn_sessions` 保存可恢复会话。Daily new words 与主题偏好保存在 `preferences`。浏览器英语语音列表可能延迟加载；没有可用语音或本地语音包时，听写会被禁用并提示切换 Copy。练习依赖已加载的本地词库，可离线操作。Practice 只表示完成拼写练习，不代表已掌握；本阶段不创建 FSRS 评分、复习排期或 Review 状态，也没有跨设备同步。

词库保存在当前浏览器配置和站点来源的 IndexedDB 中。打开页面后，词库操作可离线完成。首次加载或重新打开页面需要能访问应用。请用 localhost 或 HTTPS 访问，以便浏览器生成 UUID。清理站点数据、换浏览器配置或换访问地址会影响对原词库的访问，建议定期导出 JSON。当前词库仅保存在本设备，跨设备同步将在 Phase 5 实现。

### 数据迁移与操作日志

Dexie v2 在原数据库新增 `decks` 和 `entries`；v3 保留原有数据并新增学习表和每日额度设置。活动词条使用按单词本划分的唯一索引，移除后释放该索引，恢复时重新检查冲突。每次变更在同一事务保存业务对象与操作日志。Practice 复用 `library.outbox.sequence`，练习事件、进度、会话位置和 Outbox 操作在同一事务提交。

版本 1 的操作记录包含 `opId`、`schemaVersion`、`entityId`、`kind`、完整变更后快照 `payload`、`baseRevision`、`sequence` 和 `createdAt`。创建时本地修订号为 1，`baseRevision` 为 0，此后每次变更递增 1。`sequence` 记录设备上的提交顺序。未来的服务端修订号单独存储为 `serverRevision`，相应的操作基线为 `baseServerRevision`。

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
  contracts/     HTTP 响应、词库导出与操作日志契约
  domain/        词库校验、练习和复习事件类型
  srs/           FSRS-7 工厂与初始化测试
server/
  config/        运行配置
  db/migrations/ SQLite 迁移
  routes/        Hono API
e2e/             生产构建冒烟测试
docs/            产品与技术设计基线
.github/workflows/
```

后续学习、复习和同步以 [Phase 0 产品与技术架构设计](docs/phase-0-product-architecture.md) 为基线。
