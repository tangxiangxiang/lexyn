# Phase 5 单用户认证与同步

## Owner、运行配置和权限

- 运行 `npm run owner:init`，在终端输入并确认 12–256 字符的密码。CLI 只允许初始化一次，使用应用配置的 `LEXYN_DATA_DIR`。没有公开注册或密码重置接口。SQLite 只保存随机盐和 scrypt 哈希。
- 登录创建 256 位随机 Session Token，SQLite 保存 SHA-256 哈希。Session 14 天到期，成功登录会轮换当前浏览器的 Session，退出撤销当前 Session。单 Owner 每分钟最多尝试五次，计数保存在 SQLite 中。
- 在 `NODE_ENV=production` 下必须配置精确的 HTTPS `LEXYN_PUBLIC_ORIGIN`。生产使用 `__Host-`、Secure、HttpOnly、SameSite=Strict Cookie。开发允许回环 HTTP。默认将 Hono 绑定到回环，NAS 上应通过 TLS 反向代理转发。应用只使用配置的公开 origin，忽略 `X-Forwarded-Host` 和 `X-Forwarded-Proto`。
- 鉴权及同步接口要求 `X-Lexyn-Client: 1`。POST 另要求精确 Origin；GET 拒绝不匹配的 Origin 或跨站 Fetch Metadata。接口不提供跨域凭据 CORS，响应标记 `no-store`。同步请求的 `X-Lexyn-Owner` 必须匹配 Session 中的 Owner，以阻止登录切换期间串号。这个头和 deviceId 均不授予访问权。
- SQLite 文件位于 `LEXYN_DATA_DIR/lexyn.sqlite`，使用 WAL 和外键。一个数据库只容纳一个 Owner，个人数据由该数据库及其已验证 Session 共同限定。身份验证不阻塞本地 Library、Learn、Review 写入。

## API v1

| 接口 | 请求与结果 |
| --- | --- |
| `POST /api/auth/login` | JSON `{ password }`。成功写 Cookie 并返回 `{ session: { ownerId, expiresAt } }`。错误凭据返回 401，频率受限返回 429。 |
| `GET /api/auth/session` | 返回有效会话或 `{ session: null }`。 |
| `POST /api/auth/logout` | 撤销服务端 Session，清除 Cookie。 |
| `GET /api/bootstrap?after=0` | 首次响应的 `serverSeq` 是固定水位。后续页同时传 `after` 与 `through`，直到到达水位，再执行增量 Pull。 |
| `POST /api/sync/push` | `{ schemaVersion: 1, deviceId, cursor, operations }`。按本地 sequence 升序，最多 32 条、1 MiB。每条返回 `accepted`、`already_applied`、`conflict` 或 `rejected`。单条冲突用 409，多条用 200 和逐项结果。 |
| `GET /api/sync/pull?after=<cursor>` | 从游标之后按服务端 sequence 返回最多 100 项。响应包含 `schemaVersion`、`ownerId`、`serverSeq`、`nextCursor`、`hasMore` 和 `changes`。可用 `limit` 降低单页上限。 |

Bootstrap 在不可变变更日志上重放固定前缀，无需保持跨请求的 SQLite 读事务。水位之后的写入通过增量 Pull 补齐。当前保留完整变更日志。

Phase 6 扩展了 v1 的可选恢复代次。普通升级前后的客户端沿用未设置代次的历史。通过 SQLite 恢复命令重建服务后，登录和会话响应会提供 `generation`，同步请求需携带 `X-Lexyn-Generation`，响应页也包含对应代次。浏览器在现有 `sync_state` 行中记录绑定代次；不匹配时保留原游标和 Outbox，并拒绝继续同步。该字段不需要 SQLite 或 Dexie Schema 变更。操作步骤见 [备份与恢复](backup-restore.md)。

## 数据一致性

SQLite v2 保留 `app_meta`，新增 `owner`、`sessions`、`devices`、`decks`、`entries`、`practice_events`、`learn_progress`、`review_events`、`review_cards`、`sync_operations`、`sync_changes` 和 `sync_metadata`。SQLite 同一事务保存业务记录、操作回执和变更日志。 `opId` 检测重复请求及内容变更，事件 UUID 独立去重。ACK 丢失可用同一 operationId 和 sequence 安全重试。

词库以 `serverRevision` 判定并发。本地 `revision` 继续用于编辑校验。没有 `baseServerRevision` 的旧操作只能沿同一设备已接受的连续本地版本推进，无法覆盖另一设备的新版本。冲突时保存原操作和两端内容。用户可采用服务器版本，或基于最新远端版本创建新的提交。不同 ID 的同名词条仍各自独立，保留本地版本时可更换拼写以避开活动词条唯一约束。改变规范化英文拼写会记录并显示提示，旧评分历史和排期继续保留。

PracticeEvent 追加保存。首次完成取所有 completed 的最早完成时间，最近练习取最晚完成时间，完成次数按不同事件 UUID 统计。Skipped 不计入完成。ReviewEvent 也追加保存，来源设备的状态留作历史。服务端校验 FSRS-7 配置快照，根据有效时间和事件 ID 重放，生成唯一规范投影。超过服务端接收时间五分钟的未来评分，投影使用接收时间作为 `effectiveReviewedAt`，原 `reviewedAt` 保持不变。过去的离线评分仍按原时间进入历史。客户端有未确认评分时保留本地投影和待传操作，规范投影暂存，确认后应用最新服务端状态。

Dexie v5 新增 `sync_state`、`sync_issues`、`sync_shadows`，保留 v1–v4 迁移及数据。设备 UUID、Owner 与 origin 绑定、租约、游标和最近完成时间均在 IndexedDB 中。多标签页用数据库租约协调，并在 ACK 和 Pull 的事务内验证租约；应用数据和游标同时提交。过期登录和网络失败保留 Outbox。显式解决冲突后，原操作保留为已解决历史，退出待传队列。主题、每日新词设置和交互中的 Learn / Review 会话仍是设备本地数据。

## 首次迁移与部署边界

1. 旧设备登录现有 Owner 时先提交可兼容的 Phase 2–4 Outbox，再 Bootstrap 和 Pull。原词条、事件和操作 ID 不变。无法解释的 Phase 1 旧操作保留在 IndexedDB，由 Settings 显示。
2. 新设备登录后可直接下载整个历史。两端已有数据时独立 ID 正常合并，旧版本和同名冲突进入 Settings。已绑定另一 Owner 或服务器的设备会拒绝同步，可用独立浏览器配置访问其他账号。
3. 浏览器本地数据不会因退出而删除，也没有应用层存储加密。离线评分要求页面已加载。
4. 当前验证覆盖本地 Node.js 和双浏览器上下文。NAS HTTPS 正式部署、PWA 离线冷启动、日志压缩及 JSON 灾难恢复演练留到后续阶段。
