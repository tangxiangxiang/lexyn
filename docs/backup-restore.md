# Lexyn 备份与恢复

## 选择备份方式

| 方式 | 包含 | 用途 |
| --- | --- | --- |
| SQLite 在线备份 | Owner 凭据哈希、会话记录、词库、全部学习历史、FSRS 卡片、设备、操作回执和同步变更日志 | NAS 完整灾难恢复和版本升级前快照 |
| JSON v3 | 当前浏览器的词库、归档/移除状态、练习、复习历史、可重建卡片和每日新词设置 | 将业务历史移到一台空服务器 |

两个文件都可能包含私人数据。将备份目录限制为管理员和 Lexyn 容器用户可访问，另留一份不在应用数据卷上的副本。SQLite 备份包含凭据哈希。JSON 便于搬迁，格式不包含设备身份、登录、游标或原始 Outbox 回执。原浏览器有未确认操作时，保留浏览器配置和导出的业务快照。

## 可移植 JSON

1. 在来源设备进入 **Settings → Data & Backup** 下载 JSON。优先同步来源设备后再导出，以保证导出中的卡片投影与事件完整一致。
2. 在同一区域选择文件预览。系统会检查格式、大小（64 MiB）、引用、重复 ID 和拼写、FSRS 配置及重放结果，并标出当前浏览器是否已有数据或同步历史。当前只支持 `lexyn-library` v3，支持完整词库或单词本导出。预览只在浏览器内处理文件。
3. 初始化空目标实例的 Owner。使用空数据库，导入前不要让浏览器先同步注册设备。确认目标数据目录和文件后执行 `npm run backup:restore-json -- /path/to/backup.json --confirm-empty`。本机命令先 `npm run build`；容器命令使用镜像内的编译版本。
4. 用独立且没有 Lexyn 数据的浏览器配置访问目标，登录并等待同步。检查归档和移除历史，核对复习到期时间及每日新词设置，再导出一份作比较。导入的每日新词数作为新设备初始设置；设备已有偏好优先。

容器示例，先将文件复制到可信目录并使容器 UID 1000 可以读取。使用同一 Compose 项目和环境文件运行命令。

```sh
docker compose --env-file .env.production -f compose.production.yml run --rm \
  -v /absolute/path/lexyn.json:/restore/lexyn.json:ro lexyn \
  npm run backup:restore-json -- /restore/lexyn.json --confirm-empty
```

JSON 恢复不会覆盖已有词库或同步历史。验证全部通过才会写入，词库、事件、重放卡片与同步变更日志在一个事务中提交；失败会回滚。原始 ID、评级、复习时间与有效时间都保留。卡片状态与历史不匹配时拒绝导入，先让来源设备完成同步并重新导出。需要保留两个来源时，先分别在隔离实例中恢复并人工核对，目前没有跨实例自动合并。

## 在线 SQLite 备份

```sh
npm run backup:create -- /absolute/path/to/backups
npm run backup:verify -- /absolute/path/to/backups/lexyn-...
```

不指定输出目录时使用 `LEXYN_BACKUP_DIR`，否则默认为工作目录下的 `backups`。容器可用 `docker compose ... exec lexyn npm run backup:create`。在线备份使用 SQLite Backup API，覆盖 WAL 中已提交事务。每次生成独立目录，包含 `lexyn.sqlite` 和 `backup.json`（时间、大小、Schema 版本、SHA-256）。文件完整性及外键检查通过后才发布目录。保留最近 7 日和最近 4 周的副本，数量按实际空间调整。NAS 定时任务可调用命令，备份后复制到独立存储。

## SQLite 灾难恢复与回滚

1. 校验备份目录。停止目标 Lexyn，包括所有使用同一数据卷的容器。确认目标 `LEXYN_DATA_DIR`；不要手动删除 WAL 文件。发现 SQLite sidecar 时，先使用旧实例正常启动并停止以完成 checkpoint。
2. 执行 `npm run backup:restore -- /absolute/path/to/lexyn-backup --confirm-stopped`。Compose 用 `stop lexyn` 后 `run --rm --no-deps lexyn npm run backup:restore -- /var/lib/lexyn/backups/lexyn-... --confirm-stopped`；外部备份目录可另外以只读方式挂载。恢复命令与应用启动使用同一维护锁。原数据库保存在命令输出的 `.rollback-…` 文件中，校验过的副本原子替换目标。恢复会撤销备份中的会话，并生成新的同步代次。
3. 启动目标，检查 `/api/health` 和 Owner 登录。用新浏览器配置登录并核对词本、事件、卡片排期和同步结果。旧配置重新登录后会看到恢复提示，代次不匹配时不能使用原游标或发送旧操作。
4. 不要清除旧浏览器数据。先断开其网络并下载 JSON，留存旧浏览器配置和待同步操作；用新浏览器配置接收恢复后的服务器数据。可在另一台空实例导入旧 JSON，核对恢复点后的词库和学习历史。重要的词库改动可在新配置中按对照重新录入；若旧客户端的完整学习历史是要保留的权威版本，可将它恢复到独立空实例进行验收，再明确切换目标。两个历史分支的自动合并尚未提供。

回滚使用恢复前创建的完整备份目录，再执行同一个 `backup:restore` 命令，以生成新的代次。`.rollback-…` 原始数据库也可在隔离数据目录中打开并通过 `backup:create` 封装为完整备份，再按同一路径恢复；不要直接以旧数据库覆盖线上文件后放行旧游标。数据库版本较新的备份需要兼容的 Lexyn 构建。
