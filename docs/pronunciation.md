# MiniMax 英语发音

以 Owner 登录，打开「设置 → 发音」，填入 MiniMax API 密钥并保存。保存后即时生效。密钥留空会保留已保存的值，勾选移除后保存可清除密钥。已有音频仍可播放。设置页可切换 Calm Woman（初始候选）和 Patient Man，试听固定英语短句，并保存 0.8×、1.0×、1.2× 播放速度。播放速度仅在浏览器应用。

Lexyn 沿用 Nuvyn 的 AES-256-GCM 方式，将 MiniMax 密钥密文保存到 SQLite。第一次保存时，服务器自动在数据卷创建独立的 `.lexyn-speech-master-key`，权限为 `0600`，无需手动配置。SQLite 备份与主密钥应分开保管，恢复到新数据卷时需提供对应主密钥才能继续使用保存的 MiniMax 密钥。设置页只返回配置状态。

跟写和听写都可按需播放，复习需先揭晓答案。遇到不合适的读法，可在词条编辑器填写「发音修正」，例如尝试把 `JVM` 的合成文本改为 `J V M`。服务器把修正后的文本交给 MiniMax，最终读法需试听确认。

合成采用 [MiniMax 同步接口](https://platform.minimax.io/docs/api-reference/speech-t2a-http) 与[官方英语音色](https://platform.minimax.io/docs/faq/system-voice-id)，配置为 `speech-2.8-turbo`、英语增强、非流式 Hex、32 kHz / 128 kbps / 单声道 MP3。Lexyn 向中国区 `https://api.minimaxi.com/v1/t2a_v2` 发送请求。

音频保存在 `${LEXYN_DATA_DIR}/media/tts/`。生产 Compose 的默认路径是 `/var/lib/lexyn/media/tts/`，位于现有持久化卷中。音频按完整合成参数、大小写敏感的发音文本和修正规则复用，长期保留。参见[备份与恢复](backup-restore.md)。

每次未命中缓存的合成都可能消耗 MiniMax 额度。Lexyn 每个进程最多同时合成 2 条，每分钟最多发起 20 次合成，其中最多 4 次试听合成。每条文本最多 240 字符，单次供应商请求超时 15 秒，音频上限 2 MiB。导入词库时无需合成。

## 手动听感验收

以下命令需要显式运行，会调用 **付费 MiniMax API**，每次只生成一个 MP3。命令从 Lexyn 数据库读取已保存的密钥。`--env-file-if-exists` 仅用于定位已有的 `LEXYN_DATA_DIR` 配置。命令会打印输出文件路径，可用本机播放器打开。

```sh
node --env-file-if-exists=.env scripts/listen-speech.ts --paid English_CalmWoman concurrency
node --env-file-if-exists=.env scripts/listen-speech.ts --paid English_PatientMan 'J V M'
```

建议分别试听单词、缩写和短语，例如 `concurrency`、`queue`、`SQL`、`JVM`、`copy-on-write`。也可以在 Lexyn 中播放同一词条两次，并确认数据库里对应的音频索引只生成一次。
