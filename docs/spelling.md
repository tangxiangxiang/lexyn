# 拼写练习

学习偏好中的键盘、音节辅助、严格重写、重练上限和字母朗读保存在 Owner 的 SQLite 设置中。新会话保存这些设置的快照。会话内可为当前词切换键盘和音节提示。听写每词从完整键盘开始，开启简化键盘或显示音节时，服务器先将该词标记为辅助。

严格抄写会在第一个错误前缀提交一次尝试，短暂反馈后从头输入。严格听写在提交后校对并清空错误输入。普通模式保留输入供修改。启用重练后，有错误的词会排到本轮队尾，每词最多重练 1 至 3 次。重新打开或跨设备恢复会话时，队列和当前词位置由服务器提供。

自由拼写可从词书或 List 进入，每轮最多 100 词。正式学习和自由拼写可分别保留一轮进行中或暂停的会话。自由拼写事件有独立来源，且不写入正式 LearnProgress。FSRS 评分仍由复习流程提交。

逐字母尝试仅保存目标拼写快照、位置、错误类型、来源和尝试元数据。拼写改名后，详情只对当前版本展示位置统计。普通听写会话保留当前词最近一次失败输入供修改，完成、跳过或结束后清理。SQLite v12 与 JSON v7 支持新统计。JSON 备份延续历史导出范围，SQLite 备份可保留活动会话。

音节辅助采用小型人工核对表，按字典词头的拼写分隔显示。书面分隔用于记忆拼写，各口音中的语音音节可能不同。覆盖以外的词显示整词，不推测边界。词头来源为 Merriam-Webster 的 [apple](https://www.merriam-webster.com/dictionary/apple)、[letter](https://www.merriam-webster.com/dictionary/letter)、[bookkeeper](https://www.merriam-webster.com/dictionary/bookkeeper)、[computer](https://www.merriam-webster.com/dictionary/computer)、[information](https://www.merriam-webster.com/dictionary/information) 和 [internationalization](https://www.merriam-webster.com/dictionary/internationalization)。

字母朗读仅调用浏览器的本机语音，按英音或美音选择对应的已安装语音。缺少匹配语音时保持静默，快速输入时只播放最新字母。单词整体发音仍走既有 MiniMax 路径。
