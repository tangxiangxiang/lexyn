# Lexyn 备份与恢复

| 备份 | 内容 | 适用场景 |
| --- | --- | --- |
| SQLite 在线备份 | Owner 凭据哈希、词库、学习和复习历史、FSRS 投影、活动会话、Owner 设置、幂等回执 | 完整实例恢复 |
| JSON v6 | 词书分组、组内顺序、词库（含完整词典释义、原始译文和义项来源）、归档和移除状态、练习及复习事件、学习进度、FSRS 投影与配置、每日新词数、Owner 时区 | 将业务历史移到空实例 |

两个备份均包含私人学习数据。将备份保存在受限目录，并留一份独立于应用数据卷的副本。要继续备份时的 Learn 和 Review 会话，请使用 SQLite。JSON 保留事件引用的原会话 ID，目标实例从新的活动会话开始。

## JSON 导出与恢复

1. 在 **Settings → Data & Backup** 下载服务器 JSON，或从单词本下载该词本及其历史。
2. 在同一区域选中文件预览。验证器接受格式 v4、v5 和 v6，检查 64 MiB 上限、分组归属和顺序、引用、重复 ID、词汇唯一性、学习进度和 FSRS 重放。预览在浏览器读取文件，恢复由服务端 CLI 再独立验证。
3. 对空目标实例执行 `npm run owner:init -- <username>`。确认运行命令时使用该实例的 `LEXYN_DATA_DIR`，停止目标服务，然后执行恢复。源码工作区需先构建一次。
4. 启动目标服务，登录并核对词库、历史、卡片到期时间、每日额度和时区。

```sh
npm run backup:restore-json -- /absolute/path/to/lexyn-library.json --confirm-empty
```

恢复在单一事务中写入词库、分组、事件、重放后的卡片和设置。v6 恢复原分组 ID、名称和顺序。v4/v5 恢复时按词条创建时间、ID 排序，每 30 个词补建一组。SQLite 升级到 Schema v10 使用相同的分组规则。旧数据未记录原始导入顺序。存在业务数据或回执时，命令拒绝覆盖。对于超过 JSON 验证上限的词库，使用 SQLite 备份恢复整库。

## SQLite 在线备份

```sh
npm run backup:create -- /absolute/path/to/backups
npm run backup:verify -- /absolute/path/to/backups/lexyn-...
```

生产容器中可用 `docker compose -f compose.production.yml exec lexyn npm run backup:create`，默认使用镜像配置的备份目录。在线备份使用 SQLite Backup API，包含已提交的 WAL 数据。校验会核对 SHA-256、文件大小、SQLite Schema、引用和完整性。

SQLite 备份包含发音偏好与音频索引，MP3 文件单独存放在 `${LEXYN_DATA_DIR}/media/tts/`。如需完整保留音频，请将该目录随 SQLite 备份一起复制到备份位置（仅需正式的 `*.mp3`，保留原文件名）。恢复时把 MP3 复制回相同相对路径，保留已有音频。缺失或损坏的文件会在下次播放时按需重新生成。JSON 词库备份包含词条发音修正，跨设备发音偏好由 SQLite 备份保留。

SQLite 备份也包含 MiniMax API 密钥密文。要在新数据卷恢复该密钥，请单独备份并还原对应的 `${LEXYN_DATA_DIR}/.lexyn-speech-master-key`，保留服务用户所有权和 `0600` 权限。主密钥和 SQLite 备份分开保管。如果主密钥遗失，可在设置页移除旧凭据后重新录入 API 密钥。词库 JSON 不包含凭据。

## SQLite 恢复

1. 停止目标实例，确认目标数据目录和备份目录。
2. 执行以下命令。恢复持有与应用启动相同的维护锁。校验后的备份原子替换目标，并在目标已存在时保留命令输出中的原文件副本。
3. 启动目标，检查 `/api/health`，重新登录 Owner。恢复会撤销备份里的登录 Cookie 对应会话，保留学习会话与业务历史。

```sh
npm run backup:restore -- /absolute/path/to/backups/lexyn-... --confirm-stopped
```

使用 Compose 时，先执行 `docker compose -f compose.production.yml stop lexyn`，再以 `docker compose -f compose.production.yml run --rm --no-deps lexyn npm run backup:restore -- /var/lib/lexyn/backups/lexyn-... --confirm-stopped` 恢复。备份位于卷外时，需将目录挂载到恢复容器。
