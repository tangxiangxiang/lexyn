# Lexyn · Phase 0 产品与技术架构设计

> 版本：v0.1 · 日期：2026-11-09 · 状态：待实施的设计基线
>
> 产品理念：Learn. Recall. Retain.
>
> 仓库：https://github.com/tangxiangxiang/lexyn

## 1. 决策摘要

- **独立原创开发**：不 Fork 或复制 TypeWords 的实现；只参考其键盘学习、跟写与听写交互。第三方依赖按自身许可证合规引入。
- **沿用 Nuvyn 技术体系**：Vue 3 + TypeScript + Vite + Naive UI；Hono + Node.js；SQLite；Vitest + Playwright；Docker + GHCR + NAS。
- **学习模式 C**：新词以看词、听音、拼写为主；复习以隐藏答案、主动回忆及 FSRS 自评为主。练习正确率不等于记忆评分。
- **离线优先**：IndexedDB 持有设备上的可用学习数据；重新联网采用操作日志、服务端变更游标同步；不能以最后写入的整个进度快照覆盖其他设备。
- **面向个人使用**：单用户优先，桌面键盘优先、手机翻卡优先，初版不做 AI、社区、排行榜、支付和多租户。

## 2. 产品目标与边界

### 2.1 目标用户和设备

主要为个人长期学习英语词汇（包括计算机常用词、新概念英语等）而设计。首批环境：Windows/macOS 桌面浏览器、小米 Pad 8 Pro、Android/HarmonyOS 手机浏览器。手机端不依赖必须成功安装 PWA；PWA 是增强体验，不是唯一访问途径。

### 2.2 MVP 完整闭环

1. 创建单词本、逐条添加词汇或导入 TXT/CSV。
2. 打开单词本，学习当天的新词，查看英文、中文释义、示例与可用发音；完成拼写练习。
3. 开始主动回忆：根据中文提示想起/输入英文，揭晓答案后选择 Again / Hard / Good / Easy。
4. FSRS 根据记忆评分计算到期时间；第二天或到期时进入复习队列。
5. 离线时继续学习；恢复联网后上传事件、拉取变化并重算可用队列。
6. 在另一台设备恢复相同的单词本、复习记录和日程；支持 JSON 备份和恢复。

### 2.3 明确不做

- 不实现通用笔记、Markdown 编辑器、社交、排行榜、积分经济、云端语音转写。
- 不把大模型、MiniMax API 或在线词典接口作为 MVP 运行前提。
- 不提供多账户共享、协同编辑、商业订阅和复杂算法参数优化。
- 不直接复用 TypeWords GPL 代码；不以 Nuvyn 复杂功能为基础复制项目。

## 3. 页面与交互

| 页面 | MVP 内容 | 电脑端重点 | 手机端重点 |
| --- | --- | --- | --- |
| Library | 单词本列表、创建、导入、编辑与归档 | 列表和快捷操作 | 清晰的卡片列表 |
| Learn | 新词展示、发音、跟写、听写 | 键盘输入、回车提交 | 触控输入、简化操作 |
| Review | 到期复习、隐藏答案、自评 | 中文提示 → 输入 → 揭晓 → 1/2/3/4 评分 | 中文提示 → 心中回忆 → 翻卡 → 自评 |
| Progress | 今日新增、已复习、待复习、拼写正确率 | 克制的概览 | 简洁摘要 |
| Settings | 每日新词数、时区、发音、数据导入导出、同步状态 | 配置 | 复习偏好 |

初始默认每天学习 **10 个新词**（可配置）。到期复习优先于新词；不强制清空欠账，也不以连续打卡惩罚用户。以本地设置的 IANA 时区定义「今天」，存储时间统一为 UTC 时间戳。

### 3.1 Learn：新词学习

1. 显示英文、中文释义、可选音标/例句；按需播放发音。
2. 跟写/拼写输入；统计错误、漏字和完成情况。可视化反馈不应引导“刷正确率”。
3. 学完后允许一次**不看答案的主动回忆**，其自评才产生第一条 FSRS 复习事件。
4. 单纯重复输入、播放音频、查看答案只产生 `practice_event`，**不改变 FSRS 排期**。

### 3.2 Review：主动回忆

- 默认正面为中文释义与必要的语境提示，背面为英文单词、释义和例句；主要方向为「中文 → 英文」。
- 电脑端可输入英文并对答案进行拼写检查；手机端允许先在脑中回忆，再揭晓。
- 拼写检测结果是提示，不自动替用户选择记忆评级。答案揭晓后由用户选择：
  - Again（忘记）：无法有效回忆；
  - Hard（困难）：费力才想起；
  - Good（记得）：正常回忆；
  - Easy（轻松）：快速而准确地回忆。
- 避免中文同义释义导致的误判；MVP 支持人工判断优先。
- 键盘评分快捷键仅在答案揭晓且输入框不聚焦时激活；输入法正在组合输入时禁止误提交。

### 3.3 发音策略

首版优先使用浏览器/系统可用的语音合成与用户提供的音频字段；**离线发音取决于设备语音包和浏览器能力，不作无条件保证**。MiniMax TTS 及在线音频缓存属于后续可选增强。无发音能力不能阻塞学习与复习流程。

## 4. 技术选型与结构

| 层 | 选择 | 理由 |
| --- | --- | --- |
| Web 客户端 | Vue 3、TypeScript、Vite、Vue Router | 和 Nuvyn 开发习惯一致 |
| UI 组件 | Naive UI | 交互熟悉，保持独立品牌主题 |
| 本地持久化 | IndexedDB + Dexie | 离线可靠的结构化读写、数据库迁移 |
| 服务 API | Hono + Node.js 24 LTS | 延续 Nuvyn，满足 ts-fsrs v6 Node >= 24 要求 |
| 服务端持久化 | SQLite + better-sqlite3，WAL | 单用户自托管场景简单、维护成本低 |
| SRS | ts-fsrs v6、默认 FSRS-7 | 使用成熟算法；不手写调度核心 |
| PWA | Manifest + Service Worker | 缓存应用壳，离线启动 |
| 测试 | Vitest + Playwright | 单元、接口、双设备离线同步 E2E |
| 部署 | Docker Compose + GHCR | NAS 复用 Nuvyn 的稳定部署链路 |

版本应按 lockfile 锁定，不盲目追逐最新主要版本。`ts-fsrs` 的 **npm 包版本** 和 **FSRS 模型版本** 要分别记录；升级时不允许静默重写旧历史。

### 4.1 目录草案

```text
lexyn/
├── src/
│   ├── features/
│   │   ├── library/
│   │   ├── learn/
│   │   ├── review/
│   │   ├── progress/
│   │   └── settings/
│   ├── db/                # Dexie、本地迁移与 outbox
│   ├── sync/              # push / pull、状态恢复、错误处理
│   ├── ui/                # 极简 UI 基础组件
│   ├── router/
│   └── main.ts
├── shared/
│   ├── domain/            # 业务类型与数据校验
│   ├── contracts/         # API 请求 / 响应契约
│   └── srs/               # 固定版本的调度配置与薄封装
├── server/
│   ├── app.ts
│   ├── auth/
│   ├── db/
│   │   └── migrations/
│   ├── routes/
│   ├── sync/
│   └── srs/
├── e2e/
├── docs/
└── compose.production.yml
```

不要在 Phase 1 就引入微服务、Redis、任务队列、分布式锁、复杂 ORM 或多包工作区。单一服务足够。

## 5. 数据模型（逻辑层）

| 对象 | 关键字段 | 规则 |
| --- | --- | --- |
| `user` | `id`, `passwordHash`, `timezone` | MVP 单用户，但所有数据预留 userId |
| `device` | `id`, `userId`, `lastSeenAt` | 识别来源与同步游标 |
| `deck` | `id`, `userId`, `name`, `revision`, `deletedAt` | 单词本；支持软删除 |
| `entry` | `id`, `deckId`, `term`, `normalizedTerm`, `meaning`, `phonetic`, `example`, `revision`, `deletedAt` | 一个单词本中同一英文词条默认一份；多义在释义字段聚合；跨单词本默认独立 |
| `card` | `id`, `entryId`, `direction`, `state`, `dueAt`, `schedulerVersion`, `stateJson` | 一张卡对应一个词条、一个回忆方向；MVP 仅 zh→en；当前排期是事件重放的投影 |
| `practice_event` | `id`, `entryId`, `mode`, `correct`, `occurredAt`, `deviceId` | 练习记录，不更新 FSRS |
| `review_event` | `id`, `cardId`, `rating`, `occurredAt`, `deviceId`, `clientSeq`, `serverSeq`, `algorithmConfigVersion` | **不可变**的记忆评估历史，事件 ID 全局唯一 |
| `sync_change` | `serverSeq`, `entityType`, `entityId`, `operation`, `payload`, `createdAt` | 服务端统一增量流；可拉取所有变更 |
| `client_outbox` | `opId`, `kind`, `payload`, `baseRevision`, `createdAt`, `status` | 仅 IndexedDB；持久记录待上传写操作 |
| `sync_meta` | `deviceId`, `pullCursor`, `lastSuccessAt` | 仅 IndexedDB；用于恢复同步 |

补充规则：

- ID 使用随机 UUID。词条标准化只做 Unicode/大小写/两侧空白的合理处理，不能无条件去掉连字符、撇号等有意义字符。
- 词条重复规则限定在**同一单词本**；跨单词本允许独立记忆进度，以免不同释义的同形词意外合并。未来再考虑跨单词本合并。
- 删除单词本/词条应归档、保留记忆事件，以支持恢复与备份。普通界面不展示已归档数据。
- `card.stateJson` 等是可重建的快照；`review_event` 才是复习历史事实。不得仅同步快照覆盖事件。
- 服务端 SQLite 使用迁移版本号、事务及 WAL；客户端 Dexie 使用对应 schema version。

## 6. FSRS 调度约束

1. 从 `ts-fsrs` **v6 新 API** 开始，使用 `DefaultScheduler()`，模型固定 `FSRS-7`。
2. 初始 `desiredRetention=0.9`；可先采用官方建议的学习步长（例如 `1m / 10m`）与重学步长（例如 `10m`），以实测体验微调。
3. 一次有效复习只提交一条 `review_event`。用户的主观 Again/Hard/Good/Easy 是唯一调度评级输入。
4. 每次调度保存使用的模型/配置版本，避免未来更新使旧记录无法解释。
5. **离线投影**：设备本地根据其已知事件即时计算下一次到期；**服务器规范投影**：收到全部事件后按一致、可重现的排序规则重放并返回修正后的 card state。同步状态应清楚显示“本地未同步”。
6. 重放排序首先使用经过校验的实际复习时间（UTC），并以 `eventId` 作为稳定并列排序键。遇到明显超前的设备时钟应提示/规范化并保留原始事件时间，不得静默丢弃。
7. 由于多设备可能在尚未互相同步时复习同一张卡，**两条不同的真实评分事件不得因快照覆盖而丢失**。MVP 允许重放后排期调整，明确显示同步变化；异常重复可作为后续冲突处理 UX。
8. 不引入自训练/优化权重；个人样本量较小，初期使用内置预设即可。

> 注意：复习日志、实际时间、稳定模型版本三者要一起可导出；否则以后迁移 FSRS 算法难以做到可审计。

## 7. 离线优先与同步协议

### 7.1 本地读写

- UI 始终先读写 IndexedDB，单次操作在 Dexie 事务里更新业务对象、必要的本地投影和 `client_outbox`。
- Service Worker **只预缓存静态应用壳**（HTML/JS/CSS/图标）；不把含鉴权/个人数据的 `/api/*` 响应放进公共 Cache Storage。
- IndexedDB 允许断网打开既有单词本、复习到期卡、记录输入与评分；必须明确显示本地未同步状态。
- 不依赖 Background Sync API 一定执行；主要在打开应用、网络恢复、切回前台时重试，并允许手动点击同步。

### 7.2 增量同步（HTTP）

```text
初次：GET /api/bootstrap              # 分页获取最小初始数据及 cursor

日常：POST /api/sync/push             # 上传 outbox 中的变更/事件
      { deviceId, operations: [{ opId, kind, payload, baseRevision? }] }

      GET /api/sync/pull?after=<seq>  # 增量拉取服务端变更
      -> { changes: [...], nextCursor, hasMore }
```

- 上传操作以 `opId` 去重，断网重试不会重复计数。复习事件用 `review_event.id` 唯一约束实现幂等。
- 服务端在同一 SQLite 事务内完成写入、版本校验与单调 `serverSeq` 分配。
- 客户端拉取后，将数据变更和 `pullCursor` 在**同一个 IndexedDB 事务**提交，防止断电后跳过变化。
- 可重复请求、分页续传；网络超时或 5xx 不清空 outbox。所有失败可在界面查看。
- 词条/单词本等可编辑对象采用 `baseRevision` 乐观并发控制。冲突不静默覆盖；返回 409 和远端版本，提供保留本地/采用服务器版本的明确操作。
- 同步顺序：先 push，成功后 pull；导入与归档按依赖顺序处理。长时间离线时事件要能分批同步。
- 规范复习快照由服务端根据已确认事件确定，并作为增量变更下发；客户端以服务器规范投影替换临时预估。

### 7.3 基础安全与数据保护

- 单用户首启设置；密码哈希、服务端 session，`HttpOnly` / `Secure` / `SameSite` Cookie；受保护 API 检查会话和 Origin/CSRF。
- 正式访问必须经 HTTPS；数据库和密码不得打进前端包。设置界面不暴露敏感凭据。
- 服务器数据卷定期备份 SQLite（使用一致性备份方法）；应用提供可移植 JSON 导出，至少包含 deck/entry/review_events/算法配置/导出版本。
- JSON 导入先校验版本、结构、重复 ID，支持预览；拒绝未知不兼容格式，不部分覆盖已有数据。
- 不把浏览器 IndexedDB 当成唯一备份：设备清理站点数据后，仍可从 NAS 或 JSON 恢复。

## 8. 导入与数据质量

MVP 导入支持：

- TXT：每行 `英文<TAB>中文释义`（兼容常见分隔符需预览确认）；
- CSV：表头映射到 `term, meaning, phonetic?, example?, note?`；
- JSON：Lexyn 自身的完整备份格式。

流程：选择文件 → 解析预览 → 重复/缺失检查 → 用户确认 → 单事务导入。**不要求英文单词必须被第三方词库识别**，避免以前无法识别的计算机专业词汇再次被拒绝。全流程尽量本地完成。

## 9. UI 和可用性

- **视觉**：延续 Nuvyn 的简洁、留白、Naive UI 设计习惯；Lexyn 使用独立标识和主题色，不复刻 Nuvyn 的工作区导航。
- **桌面**：全键盘主要流程；输入焦点明确；Enter 提交、Space 揭晓、1–4 评分要防止输入冲突。
- **平板**：触摸区域足够大，同时允许实体键盘操作。
- **手机**：单列复习卡片、明显的“揭晓答案”和四档评分；输入拼写是可选强化训练，不是完成复习的唯一方式。
- **无障碍**：足够对比度、可见焦点、读屏标签、可关闭动画；重要状态不能只通过颜色表达。
- **同步反馈**：至少区分“已同步 / 离线待同步 / 正在同步 / 需要处理”。

## 10. 阶段拆分

| 阶段 | 交付目标 | 可验证结果 |
| --- | --- | --- |
| Phase 0 | 本文档与 ADR 决策基线 | 核心场景、存储及同步语义有明确结论 |
| Phase 1 | 仓库初始化、Vue/Hono/SQLite/Dexie、测试脚手架、基本 UI | 构建、typecheck、CI、健康检查全部通过 |
| Phase 2 | Library、单词管理、TXT/CSV 导入、JSON 导出 | 可导入个人词库，重启不丢数据 |
| Phase 3 | Learn、跟写/听写、练习记录 | 桌面可完成新词学习，手机基础适配 |
| Phase 4 | Review、FSRS-7 与本地队列 | 回忆评分能改变复习日程；练习不影响排期 |
| Phase 5 | 账号、安全、push/pull、双设备同步、冲突处理 | 双设备离线评分可汇合，不丢日志、不重复应用 |
| Phase 6 | PWA、响应式打磨、生产部署与恢复测试 | NAS 运行、可离线复习、备份恢复可靠 |

### 10.1 MVP 发布门槛

必须完成 Phase 1–6，并实测桌面 + 平板 + 手机浏览器的基本学习、同步与恢复流程；不以“仅支持本机”冒充跨设备 MVP。

## 11. 必须覆盖的测试

1. 拼写正确/错误均不单独修改 FSRS 排期；只有评分事件修改排期。
2. 同一个 `opId` / `review_event.id` 连续上传三次，只产生一次实际应用。
3. A 电脑在线、B 手机离线：B 完成复习，A 继续学习，B 重联网后两侧都保留事件且排期收敛。
4. 两个设备离线复习同一张卡：两条不同的评分事件保留，并以相同排序逻辑得到同一规范状态。
5. 服务端保存成功后、客户端收到 ACK 前断线：重试不得重放重复事件。
6. 拉取某页变更后断电：游标不能前移而业务数据未写入。
7. 单词本修改冲突返回可理解的状态，不静默覆盖。
8. PWA 离线重新打开仍可学习；Service Worker 缓存不泄露 API 响应。
9. 导出 JSON 后重建实例并导入，词库、复习日志、到期时间可恢复。
10. 有输入法组合态、网络异常、时区变化以及过期 session 的体验测试。

## 12. 工程与发布约束

- 采用常规 TypeScript 严格类型检查、格式化、关键业务单测以及少量 Playwright 核心路径，不从首日复制 Nuvyn 的大规模测试矩阵。
- 主分支 `main`；CI 最小要求 `typecheck + unit tests + build + smoke e2e`。通过后再构建发布镜像。
- 对 NAS 优先支持其实际 x86_64 架构；是否额外发布 arm64 镜像按需要决定。镜像使用不可变 tag/digest；生产 compose 从 GHCR 拉取而不在 NAS 编译。
- 独立容器、独立持久化卷、独立数据库与端口，不与 Nuvyn 共享内存状态和数据库。
- 仓库当前未指定开源许可证；不要在初始化时擅自添加 MIT/GPL 等项目级 LICENSE。若延续 Nuvyn 的源代码可见但保留权利策略，须单独设计版权声明；遵守所用第三方依赖的许可证与 NOTICE 要求。

## 13. Phase 0 验收结论

已确定：产品是“拼写学习 + FSRS 主动回忆”的独立个人工具；技术沿用 Nuvyn，但在 Node 版本、客户端本地存储、数据同步上做有目的的调整；数据采用事件日志与排期投影分离；开发划分为六个可验收阶段。

尚待编码验证（不妨碍进入 Phase 1）：`ts-fsrs` v6 在目标前端构建下的兼容性、Dexie 迁移性能、双设备同步冲突时的具体 UI 文案、华为浏览器 PWA 安装与离线能力。每项都有回退路径：保留纯 Web 访问、明确同步状态、必要时将调度 API 封装隔离。

## 参考资料

- Nuvyn 仓库（技术架构参考）：https://github.com/tangxiangxiang/nuvyn
- Lexyn 仓库：https://github.com/tangxiangxiang/lexyn
- ts-fsrs 官方快速开始：https://open-spaced-repetition.github.io/ts-fsrs/guide/quick-start
- ts-fsrs 更新记录：https://open-spaced-repetition.github.io/ts-fsrs/updates/
- Dexie 文档：https://dexie.org/docs/Dexie.js
- MDN PWA 离线机制：https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation
