# Lexyn

**Learn. Recall. Retain.**

Lexyn 是一款面向个人的词汇学习与长期记忆工具，支持词书分组学习、拼写练习、FSRS-7 主动回忆、单用户跨设备访问和可安装的 PWA。

## 技术栈

- Web：Vue 3、严格模式 TypeScript、Vite、Vue Router、Naive UI
- 服务端：Node.js 24、Hono、better-sqlite3（WAL）
- 浏览器存储：本机外观偏好与 PWA 静态应用壳
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
| `LEXYN_PUBLIC_ORIGIN` | 本地启动地址 | 浏览器访问的精确 origin。开发默认接受 `http://127.0.0.1:5173` 和 `http://localhost:5173`，生产必须显式配置 HTTPS。 |
| `LEXYN_DATA_DIR` | `./data` | SQLite 数据目录。相对路径以启动时的工作目录为准 |

## 本地开发

```sh
npm run dev
```

在 Vite 输出的地址打开应用，默认是 `http://127.0.0.1:5173`。前端支持热更新，Vite 将 `/api` 请求转发给 Hono。访问 `/api/health` 可检查服务和 SQLite。

## 使用 Library

1. 在 **Library** 查看词书、单词数和分组进度。点 **New deck** 新建词书。打开词书后，可用分组选择器或上一组、下一组浏览，并从当前组开始或继续学习。
2. 在词书的 **Deck options** 中添加或导入单词。默认每组 30 词，可选 20、30、50 或自定义 1–100。导入去重后按文件顺序追加，已完成的末组保持原样。分组大小与每日新词额度分别设置。
3. **Search and filters** 支持搜索英文和中文释义，查找待补释义及恢复移除词条。书架的 **Library options** 可查看已归档词书。恢复词条时若已有同名活动词条，会提示冲突。

导入文件使用 UTF-8，可带 BOM。每个文件最多 5 MiB、10,000 条数据记录。TXT 支持每行一个词或词组，也支持英文和释义之间使用一个 Tab。可以在预览中手动指定格式。CSV 使用逗号分隔，首行是表头。将源列映射到 `term` 和 `meaning`，后者允许空值。还可以映射 `phonetic`、`example` 和 `note`。CSV 支持字段内逗号、转义双引号和换行。

```csv
term,meaning,example
copy-on-write,写时复制,"This uses copy-on-write, a common optimization."
WAL,,
```

确认前可查看有效行、重复行、无效行与缺失释义数。重复比较按单词本进行，对词汇做 NFC 规范化、去除首尾空白并统一大小写。文件内保留第一条有效记录。已有词条默认跳过，显式选择覆盖时保留原 ID，并仅修改映射到的字段。无效记录会列在预览中并跳过。文件编码、CSV 结构或文件限制有问题时会阻止导入。专业词汇、缩写和词组可以直接添加。

**Export library** 下载服务器上的全部词库与学习历史，包括归档词本和已移除词条。**Export deck** 下载单个词本及其可独立恢复的历史。JSON v8 保存分组、全局词汇身份、共享进度与 FSRS 映射，继续支持恢复 v4–v7。可在 **Settings → Data & Backup** 验证文件，再用 CLI 恢复到空实例。见 [备份与恢复](docs/backup-restore.md)。

新增词条先保存到服务器，再由 MiniMax 异步生成完整结构化释义。安装 ECDICT 时，MiniMax 会同时参考只读的 ECDICT 原文；未安装时也可独立生成。编辑器只显示单词、英音/美音/未区分音标和按词性分组的完整释义。再次优化时以当前已保存释义为主要输入，ECDICT 原文作为参考。[ECDICT 安装及使用](docs/dictionary.md) · [AI 词汇增强](docs/vocabulary-ai.md)

## 使用 Learn

1. 从词书的当前分组进入 Learn。练完可返回原组，完成整组后可前往下一组。Learn 首页也可继续已有会话或选择活动词书。
2. 每日新词默认 10 个，Settings 中可设为 1–100。额度按 Owner 设置的时区、跨全部单词本统计。当天完成首次练习的词计入额度；跳过不计入。额度用完后仍可练习已完成首次学习的旧词。
3. **Copy** 显示英文词、完整释义和音标；**Dictation** 隐藏英文词与释义，通过 Lexyn 服务器播放英语发音。两个模式均可播放，听写失败时可重试或切换到跟写。提交后显示拼写反馈，错误后可改正重试。见 [MiniMax 发音设置与试听](docs/pronunciation.md)。
4. Learn 会自动保存队列位置。离开页面或刷新后可继续活动会话；使用暂停/结束操作返回 Learn 首页后，也可以继续或放弃会话。放弃不会删除已保存的练习历史。

练习结果、进度、尝试次数和当前会话保存在 SQLite，换设备登录后可以继续。完成拼写练习只创建 PracticeEvent。带中文释义的词条完成首次学习后会成为 Review 候选，FSRS 从首次人工评分开始排期。听写进入当前词条后向服务器提前准备音频，点击后播放。语音不可用时可重试或切换 Copy。

## 主动回忆（Review）

打开 **Review** 可以复习全部活动词本，或选择单个词本。正面只展示中文释义，可选输入回忆结果，或直接点 **Show answer**。揭晓后选 Again、Hard、Good 或 Easy，拼写仅用于自查。桌面可在卡片区域用空格揭晓、用 1–4 评分。复习可暂停，刷新后会恢复位置和揭晓状态。

首次回忆和已到期复习分开统计。到期的学习或重学卡片优先，其次是到期复习卡片，再是首次回忆。下一次到期时间来自 ts-fsrs v6 的 FSRS-7 排期。Progress 从服务器读取学习与复习统计，今日按 Owner 时区计算。

每次评分在同一 SQLite 事务中保存不可变 ReviewEvent、可重建的卡片投影、会话和幂等回执。词本、词条和学习会话使用服务器修订号。两台设备同时操作同一个版本时，后到的陈旧请求会收到冲突提示，可以重新读取会话后继续。

## Owner 与跨设备访问

首次启动时，从服务端终端复制一次性设置令牌，在网页 **Set up Lexyn** 中设置用户名和 Owner 密码，完成后会自动登录。旧版使用默认用户名的实例会显示 **Choose your username**。输入终端令牌和原密码即可选择用户名，学习记录保留。在任意设备打开同一个 Lexyn 地址并登录，页面从同一 SQLite 读取业务数据。界面默认简体中文，可在登录页或 **设置 → 语言** 切换为 English。语言选择保存在当前浏览器。可在设置中修改时区和每日额度，或退出登录。断网时，已安装的 PWA 可以打开应用壳并提示重试，学习和写入需要连接服务器。

### Phase 7A 开发库重置

如果此前运行过旧版本，先停止开发进程，给 Phase 7A 配置一个新的 `LEXYN_DATA_DIR`，例如将 `./data` 改为 `./data-server-first`。随后用新目录启动 `npm run dev`，并在网页完成首次设置。默认数据库名仍是 `lexyn.sqlite`。启动发现版本 1 或 2 的开发库会报错，原文件可以留在原目录。

## 构建与启动

```sh
npm run build
npm start
```

从项目根目录启动。默认访问 `http://127.0.0.1:3000`，静态资源、SPA 路由和 API 由同一进程提供。SQLite 数据位于数据目录的 `lexyn.sqlite`，启动时按版本执行迁移。更换数据目录会打开另一份数据库。

## NAS、PWA 与备份

- [NAS HTTPS、Compose 与镜像发布](docs/deployment.md)
- [JSON 与 SQLite 备份及恢复](docs/backup-restore.md)
- [ECDICT 独立词典安装与更新](docs/dictionary.md)
- [PWA 安装、连接错误和代理检查](docs/pwa.md)

## 测试

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright 使用生产静态构建。每个测试在独立回环端口上启动 Hono，使用临时 SQLite 和测试 Owner。CI 在 Ubuntu 上运行同一套检查。

## 工程结构

```text
src/
  app/           应用外壳与 Naive UI Provider
  components/    页面空状态与共享图标
  features/      Library、Learn、Review、Progress、Settings
  api/           同源 API Client 与会话状态
  router/        路由与主导航
  styles/        设计变量与响应式布局
  ui/            主题状态和图标定义
shared/
  contracts/     HTTP 响应、校验与词库备份契约
  domain/        词库校验、练习和复习事件类型
  srs/           FSRS-7 工厂与初始化测试
server/
  config/        运行配置
  db/migrations/ SQLite 迁移
  auth/          Owner 初始化、登录及 Session
  study/         业务 API、服务端学习与复习事务
  backup/        JSON 验证恢复与 SQLite 在线备份
  dictionary/    ECDICT CSV 导入、只读 SQLite 和查询 API
  ai/vocabulary/ MiniMax 释义与词典优先批量任务
  routes/        健康检查
e2e/             生产构建冒烟测试
docs/            产品与技术设计基线
.github/workflows/
```

[Phase 0 产品设计](docs/phase-0-product-architecture.md) 记录早期决策。数据架构以 Phase 7A 实现为准。
