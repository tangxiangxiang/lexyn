# ECDICT 服务器词典

Lexyn 的 ECDICT 是可选的、服务器端的、只读的英汉词典，未安装时原有的 Library、Learn、Review、MiniMax AI 释义和 TTS 仍可用。ECDICT 本地查询不消耗 MiniMax 额度。

## 来源与授权

词典来源：[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)，采用官方 ecdict.csv (UTF-8)。官方仓库声明 MIT License (Copyright (c) 2025 Linwei)，应保留仓库、许可证和来源信息。ECDICT 整合了多种历史数据来源，商业分发完整词典内容前请核实上游权利；Lexyn 仓库与公开 Docker 镜像不包含完整 CSV 或转换后的数据库。

导入会将来源版本、CSV SHA-256、导入时间和词条数保存到词典数据库。建议从官方提交 SHA 获取对应 CSV，避免使用不明第三方预转换文件。

## 本地安装（Node.js 24）

先停止 Lexyn 服务并确认没有备份恢复任务，执行：

~~~sh
npm ci
npm run dictionary:import -- /absolute/path/to/ecdict.csv <ECDICT-commit-SHA>
~~~

可通过 .env 配置 LEXYN_DATA_DIR；默认 data/，词典存储位置为 data/dictionaries/ecdict.sqlite，用户业务数据库仍为 data/lexyn.sqlite。

导入工具流式解析 CSV，支持带引号字段与多行译文；按批次事务写入独立临时 SQLite，创建查询索引，运行 integrity_check，再替换词典文件。失败不会删除或修改 Lexyn 用户词库。已经打开的只读词典连接需要重启 Lexyn 才会重新读取新的词典文件。

在 **Settings → Dictionary** 可查看安装状态、词条数和来源版本。业务页面只使用按单词匹配的服务器参考，不提供原始词典浏览器。

## Docker / NAS（以后部署使用）

本次代码更新没有执行 NAS 部署。生产 Docker 镜像包含 dist-server 编译文件，不包含 server/ 的 TypeScript 源文件。使用同一持久化数据卷挂载 /var/lib/lexyn，将官方 CSV 以只读 bind mount 额外挂载，例如：

~~~text
/host/path/ecdict.csv:/import/ecdict.csv:ro
~~~

在主 Lexyn 服务停止后，通过 Docker Compose 一次性容器覆盖默认启动命令，执行：

~~~sh
node dist-server/server/dictionary/cli.js /import/ecdict.csv <ECDICT-commit-SHA>
~~~

应使用 docker compose run --rm 或等价方式，确保同一个 lexyn-data 卷可写且主应用未占用维护锁。不要把约 66MB CSV 复制进容器内只有 32MB 的 /tmp tmpfs。导入完成后重启 Lexyn。

SQLite Online Backup 只备份 lexyn.sqlite，不自动包含 dictionaries/ecdict.sqlite。可在 NAS 上单独备份该词典文件，或者保存官方 CSV 与 SHA-256，以便重新生成。词条已保存的释义与来源标签仍会进入 Lexyn JSON v5。

## ECDICT 与最终释义

- ECDICT 是可选、只读的生成参考。日常 Library、Learn、Review 和词条编辑器不直接展示原始词典内容，也不会把解析后的 ECDICT 内容直接当作最终释义。
- 新词保存后，服务器异步调用 MiniMax。词典已安装时，请求同时包含该词的 ECDICT 原文；未安装或未收录时，MiniMax 可独立生成。词典导入、查询和 AI 释义都不会改写 ECDICT 数据库。
- 词条保存的 `Entry.meaning` 是结构化释义的完整文本投影。`Entry.dictionaryMeaning` 保存最终的词性、完整义项、来源和生成元信息；`Entry.dictionaryReference` 保存用于该词的 ECDICT 原文快照及版本。两者随 JSON v5 导出和恢复。
- ECDICT 解析依据显式词性与领域标记，兼容 CSV 中实际换行和字面 `\\n`。标准列表中的逗号可拆为多个义项；括号、引号和有歧义的子句保留为原始片段。解析结果只作为 AI 输入，最终结构由模型生成并经服务端校验。
- 再次优化释义时，服务端读取当前最新保存的完整释义作为主要输入，并附上 ECDICT 原文作为辅助依据。人工修改与 AI 生成没有来源优先级；每次保存递增 Entry revision。若 AI 响应返回时 revision 已变化，会拒绝写入并保留较新的释义。
- Library、Learn 和 Review 读取最终完整释义；Review 正面显示完整中文释义，揭晓后显示英文答案和完整释义。旧 `explanation`、`example`、`note` 字段仍可兼容保存，但不在日常学习界面展示。
- ECDICT 通用音标只写入未区分音标字段，不推断英音或美音。英美音标由词条数据明确提供时分别显示；没有可靠音标时隐藏音标区域。MiniMax TTS 与音标数据完全独立。

## 验证

CI 使用小型 CSV Fixture，不下载完整 ECDICT，不调用真实付费 API：

~~~sh
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

CI 使用符合 ECDICT CSV 格式的小型 Fixture 验证导入、解析、只读参考、生成及备份往返，不下载完整词典，也不调用真实付费 API。完整 ECDICT 的安装耗时、磁盘占用和不同词条的释义质量需在目标服务器安装后抽样核对。
