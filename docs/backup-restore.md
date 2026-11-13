# Lexyn 备份与恢复

| 备份 | 内容 | 适用场景 |
| --- | --- | --- |
| SQLite 在线备份 | Owner 凭据哈希、词库、学习和复习历史、FSRS 投影、活动会话、Owner 设置、幂等回执 | 完整实例恢复 |
| JSON v8 | 词书分组、组内顺序、词库（含完整词典释义、原始译文和义项来源）、归档和移除状态、练习及复习事件、逐字母拼写记录、学习进度、拼写偏好、FSRS 投影与配置、每日新词数、Owner 时区 | 将业务历史移到空实例 |

两个备份均包含私人学习数据。将备份保存在受限目录，并留一份独立于应用数据卷的副本。要继续备份时的 Learn 和 Review 会话，请使用 SQLite。JSON 保留事件引用的原会话 ID，目标实例从新的活动会话开始。

## JSON 导出与恢复

1. 在 **Settings → Data & Backup** 下载服务器 JSON，或从单词本下载该词本及其历史。
2. 在同一区域选中文件预览。验证器接受格式 v4–v8，检查 64 MiB 上限、分组归属和顺序、引用、重复 ID、词汇唯一性、学习进度和 FSRS 重放。预览在浏览器读取文件，恢复由服务端 CLI 再独立验证。
3. 对空目标实例执行 `npm run owner:init -- <username>`。确认运行命令时使用该实例的 `LEXYN_DATA_DIR`，停止目标服务，然后执行恢复。源码工作区需先构建一次。
4. 启动目标服务，登录并核对词库、历史、卡片到期时间、每日额度和时区。

```sh
npm run backup:restore-json -- /absolute/path/to/lexyn-library.json --confirm-empty
```

恢复在单一事务中写入词库、分组、事件、经重放校验的原始卡片和设置。v6 及之后的格式恢复原分组 ID、名称和顺序。v7 及之后的格式也恢复拼写记录和偏好。旧格式保留已有练习事件，逐字母记录从新练习开始。v4/v5 恢复时按词条创建时间、ID 排序，每 30 个词补建一组。SQLite 升级到 Schema v10 使用相同的分组规则。旧数据未记录原始导入顺序。存在业务数据或回执时，命令拒绝覆盖。对于超过 JSON 验证上限的词库，使用 SQLite 备份恢复整库。

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

## SQLite v13 全局词汇迁移

词书成员仍使用原 Entry ID，分组沿用原 List ID 和顺序。新增 `words`、`word_progress`、`word_cards`。同词的首次完成时间取最早记录，最近练习取最晚记录，正式完成次数相加。每日额度按唯一 Word 的首次完成计数。自由拼写和重复练习不会再次消耗额度。

每个 Word 和复习方向只使用一条有效调度链。多张旧卡的选择顺序为最近一次评分、历史事件数量、Card ID 升序。所有旧卡与事件均按原 ID 和内容保留，历史链分别校验和回放。旧版改名没有保留足够身份信息时，改名前或跨改名的记录隔离保留，避免将旧记忆分配给新拼写。短全大写英文缩写采用独立的身份变体，例如 `US` 与 `us`。

### 生产升级前

1. 停止学习写入，使用当前版本生成一致性 SQLite 备份。保留旧镜像 digest，把备份复制到应用卷之外并校验。
2. 使用 **新版本**的 CLI，对备份运行以下两条命令。预检只读取原备份，在临时数据库中回放旧链并执行 v13 迁移。输出包括前后行数、跨词书重复数、多链词汇及选用卡片、大小写歧义和改名历史。保管报告，它包含私人词汇。
3. 对照报告核对卡片、事件、练习和活动会话数量。若校验失败，停止升级并保留原库和备份。也可把备份还原到隔离实例，检查学习、复习和再次导出。
4. 确认备份覆盖停写后的最终状态，再启动新版本迁移生产库。迁移在一个事务内执行，检查外键和完整性。验收同词跨书进度、原会话游标和卡片到期时间后再恢复写入。

```sh
npm run backup:verify -- /absolute/path/to/backups/lexyn-...
npm run backup:audit-words -- /absolute/path/to/backups/lexyn-...
```

要回退到 v12，停止新版本，先另存 v13 实例，然后恢复升级前已验证的 SQLite 备份，再启动旧镜像。v12 应用无法打开 v13。升级之后产生的写入留在另存的 v13 备份中，恢复 v12 时不会自动合并。

### JSON v8 的范围

整库导出包含所有 Word、成员、全局进度、练习和拼写映射，以及所有有效和保留的旧 FSRS 链。恢复会分别回放每条链进行校验，并保存备份中的原始排期快照。v4–v7 恢复时会补建 Word、进度和有效卡片映射。

单本词书导出只包含该词书的内容和练习，按本书实际事件生成进度。仅当整条卡片链的来源词条和所有评分词条都在本书时，才导出该链。跨书链和其他书的笔记不进入单本备份。迁移共享记忆或恢复完整学习状态时，请使用整库 JSON 或 SQLite。
