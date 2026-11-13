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

在 **Settings → Dictionary** 可查看安装状态、词条数和来源版本。内置词书页面提供带分页的标签词表预览。

## 内置词书与分级

中考、高考、CET4、CET6、考研、IELTS 和 TOEFL 分别取自 ECDICT 的 `zk`、`gk`、`cet4`、`cet6`、`ky`、`ielts`、`toefl` 标签。小学、初中、高中保留为目录项，等待可验证的独立词表。考试覆盖范围以导入的版本为准。ECDICT v1 本地词典仍可查询和安装词书，重新导入原 CSV 可恢复原始 Collins 与 Oxford 字段并生成持久化索引。

词书预览按全局英语 Word 身份计数，使用同一套筛选规则生成安装快照。分类和等级选项在同一维度内取并集，不同维度取交集。按词频排序时 BNC、FRQ 分开使用，较小排名表示更常见，缺失排名排在末尾。Collins 星级来源于 ECDICT，范围为 1 至 5。默认按规范拼写排序。已安装词书保留安装时的顺序、分组、释义和来源版本。重复安装会打开或恢复现有词书。筛选后的成员变化或词典换版需要重新确认预览。

安装在独立线程中使用一笔 SQLite 事务保存词书、词条、List 和请求回执。可以在提交前取消，提交后关闭页面不会取消服务端事务。进程中断且事务尚未提交时，SQLite 回滚整笔安装，重启后可重新确认并提交。

### 可选 CEFR 来源

安装使用 Open Language Profiles 发布的独立词汇数据。CEFR-J 1.5 覆盖 A1–B2，使用时须注明编者 Yukio Tono 和 Tokyo University of Foreign Studies。上游许可允许署名的研究及商业使用，原始文件的再分发权未单独确认。Octanove Labs 1.0 覆盖 C1–C2，采用 CC BY-SA 4.0。管理员可自行下载并安装这些数据。见 [数据文件与使用条款](https://github.com/openlanguageprofiles/olp-en-cefrj#terms-of-use)。

停止服务后，使用从上游获得的 CSV 导入，并重启 Lexyn：

~~~sh
npm run dictionary:import -- cefr cefr-j /absolute/path/to/cefrj-vocabulary-profile-1.5.csv 1.5
npm run dictionary:import -- cefr octanove /absolute/path/to/octanove-vocabulary-profile-c1c2-1.0.csv 1.0
~~~

Docker 环境使用同一数据卷和只读 CSV 挂载，将命令前缀替换为 `node dist-server/server/dictionary/cli.js`。CEFR 文件写入独立的 `dictionaries/classification.sqlite`。按英语 Word 规则匹配词头，斜杠分隔的拼写变体分别匹配，保留同一词头的多个来源和等级。筛选命中任一已选等级即保留该词。未覆盖的词显示为未知。等级按词头匹配，无法精确对应 ECDICT 的每一个义项。

### 统计口径

全局已学按唯一 Word 计数，今日新学按首次完成正式学习的 Owner 日期计数。今日复习同时显示按复习重置时间划分的实际评分次数和唯一 Word 数。日历按 Owner 当地自然日汇总新学和评分，连续学习延用正式完成或复习评分的记录。各词书的待复习量和下一次复习来自可用的全局 FSRS 卡片。自由拼写单独计数。易错词按近 30 天的非提示练习汇总，至少两次会话有错且失败会话占一半以上才纳入。

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

SQLite Online Backup 只备份 lexyn.sqlite，不自动包含 dictionaries/ecdict.sqlite。可在 NAS 上单独备份该词典文件，或者保存官方 CSV 与 SHA-256，以便重新生成。词条已保存的释义与来源标签仍会进入 Lexyn JSON v9。

## ECDICT 与最终释义

- ECDICT 是可选、只读的生成参考。日常 Library、Learn、Review 和词条编辑器不直接展示原始词典内容，也不会把解析后的 ECDICT 内容直接当作最终释义。
- 新词保存后，服务器异步调用 MiniMax。词典已安装时，请求同时包含该词的 ECDICT 原文；未安装或未收录时，MiniMax 可独立生成。词典导入、查询和 AI 释义都不会改写 ECDICT 数据库。
- 词条保存的 `Entry.meaning` 是结构化释义的完整文本投影。`Entry.dictionaryMeaning` 保存最终的词性、完整义项、来源和生成元信息；`Entry.dictionaryReference` 保存用于该词的 ECDICT 原文快照及版本。两者随 JSON v9 导出和恢复。
- ECDICT 解析依据显式词性与领域标记，兼容 CSV 中实际换行和字面 `\\n`。标准列表中的逗号可拆为多个义项；括号、引号和有歧义的子句保留为原始片段。解析结果只作为 AI 输入，最终结构由模型生成并经服务端校验。
- 再次优化释义时，服务端读取当前最新保存的完整释义作为主要输入，并附上 ECDICT 原文作为辅助依据。人工修改与 AI 生成没有来源优先级；每次保存递增 Entry revision。若 AI 响应返回时 revision 已变化，会拒绝写入并保留较新的释义。
- Library、Learn 和 Review 读取最终完整释义；Review 正面显示完整中文释义，揭晓后显示英文答案和完整释义。旧 `explanation`、`example`、`note` 字段仍可兼容保存，但不在日常学习界面展示。
- ECDICT 通用音标是 MiniMax 生成英美 IPA 时的辅助参考。AI 未生成可用音标且词条没有已有音标时，可以使用 ECDICT 通用音标回退。Library、Learn 和 Review 为英美音标加上对应口音标签，通用音标仅显示带斜杠的音标。手动清空音标会阻止自动补回。

## 导入释义与拼写变更

- CSV 导入界面只提供单词、释义和音标列映射。Example、Note 等旧字段仍保留在已有词条和 JSON 备份中，但不会由新导入映射覆盖。
- 覆盖同一单词时，新的非空释义会成为 `source: manual` 的最新最终释义，不推断词性；文本较长或含换行、无法无损放入结构化义项时，原文保存在 `Entry.meaning`。相同释义保留已有结构化数据；空白或未映射释义不会清空已有释义。旧词条的 ECDICT 原始快照会继续关联同一个单词。
- 之后的 AI 优化以 CSV 导入的最新释义为主要输入，并保留 ECDICT 快照作为参考。真实保存不同拼写时，服务端清除旧释义、词典快照和音标，原拼写的 FSRS 历史和排期留在原 Word；编辑器只在保存边界执行此清理，临时更改后恢复拼写不会损坏草稿。

## 验证

CI 使用小型 CSV Fixture，不下载完整 ECDICT，不调用真实付费 API：

~~~sh
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

CI 使用符合 ECDICT CSV 格式的小型 Fixture 验证导入、解析、只读参考、生成及备份往返，不下载完整词典，也不调用真实付费 API。完整 ECDICT 的安装耗时、磁盘占用和不同词条的释义质量需在目标服务器安装后抽样核对。

### 实测数据版本

使用 ECDICT 提交 `39cfb9672c0906b63569e0453c2e6abfb9ab182a`（CSV SHA-256 `d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc`）在本机临时目录验证了 770,611 条原始词条。其中有效 Collins 星级 13,633 条，BNC 排名 45,443 条，FRQ 排名 42,231 条，Oxford 核心标记 3,461 条。

| 内置词书 | 可安装的唯一 Word | 有 CEFR 记录 |
| --- | ---: | ---: |
| 中考 | 1,603 | 1,549 |
| 高考 | 3,677 | 3,307 |
| CET4 | 3,849 | 3,345 |
| CET6 | 5,407 | 3,956 |
| 考研 | 4,801 | 3,844 |
| IELTS | 5,040 | 3,260 |
| TOEFL | 6,974 | 3,565 |

CEFR 数据来自 Open Language Profiles 提交 `d4e45b75b38f27b30dfc5c44d8c571aec7e7092f`。CEFR-J 1.5 导入 7,023 个词头，Octanove 1.0 导入 1,998 个词头。两者可有重叠。预览首屏约 20–55 ms，TOEFL 安装约 0.7 秒。此测量取自本机临时数据库，部署环境的磁盘和并发负载会影响耗时。
