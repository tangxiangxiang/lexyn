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

在 Settings → Dictionary 可查看安装状态、词条数和来源版本；在 Library 的新增或编辑词条界面点击 Look up in ECDICT（查询 ECDICT）进行查询。

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

SQLite Online Backup 只备份 lexyn.sqlite，不自动包含 dictionaries/ecdict.sqlite。可在 NAS 上单独备份该词典文件，或者保存官方 CSV 与 SHA-256，以便重新生成。词条已保存的释义与来源标签仍会进入 Lexyn JSON v4。

## 释义选择策略

1. 单词编辑器可以查询词典原始翻译及音标，选择或编辑简短候选，再通过 Save 保存，不会自动覆盖现有手工释义。
2. 在缺少释义筛选中启动批量补全，优先使用 ECDICT 单行、简短且明显无歧义的中文释义，记为 meaningSource: dictionary。
3. 未收录、复杂多义词或 Core Java 等专业语境下风险较高的词会交给 MiniMax，并只提交单词相关的有限词典参考，生成结果记为 meaningSource: ai。
4. 未配置 MiniMax 时，明确词义仍可由 ECDICT 独立补全；其余词保留未补全状态，绝不猜测用户要记忆的词义。
5. ECDICT 与独立的 MiniMax TTS 不相互依赖。查询词典不会自动修改 ReviewEvent、PracticeEvent 或 FSRS。

本地 CSV 原始翻译可能包含大量多义、词性和网络释义，不应直接复制成长篇 Review 提示。词库一律以最终保存到 Entry.meaning 的简短释义为学习依据。

## 验证

CI 使用小型 CSV Fixture，不下载完整 ECDICT，不调用真实付费 API：

~~~sh
npm run typecheck
npm test
npm run build
npm run test:e2e
~~~

完整 CSV 的真实导入耗时、磁盘空间占用和释义质量需要在手动安装之后验收。
