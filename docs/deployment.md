# Lexyn NAS 部署

## 首次部署

准备支持 Compose 的 Docker、`linux/amd64` NAS、可信 HTTPS 证书、独立的 Lexyn 数据卷及独立的备份存储。发布流程目前配置为 `ghcr.io/tangxiangxiang/lexyn`。部署时使用实际已发布的版本或 digest。

```sh
cp .env.production.example .env.production
# 填写 LEXYN_IMAGE 和浏览器访问的 LEXYN_PUBLIC_ORIGIN

docker compose --env-file .env.production -f compose.production.yml pull
docker compose --env-file .env.production -f compose.production.yml up -d
docker compose --env-file .env.production -f compose.production.yml logs lexyn
```

首次启动时，从 Lexyn 日志复制一次性设置令牌，在 HTTPS 页面中设置 Owner 用户名和密码。也可以通过受保护的环境配置传入至少 32 字节的随机 `LEXYN_SETUP_TOKEN`，服务端不会打印该值。备份恢复和自动化可运行 `npm run owner:init:production -- <username>`，密码从交互终端或受保护的标准输入读取。

镜像运行 Node.js 24 Debian slim，原生 SQLite 模块在同一 Linux 基础镜像和目标架构上安装。运行用户 UID 1000、根文件系统只读、无额外 capabilities。命名卷挂载到 `/var/lib/lexyn`，承载 SQLite、维护锁和默认备份目录。`LEXYN_DATA_DIR`、`LEXYN_BACKUP_DIR` 可选用此卷下的独立目录。自定义绑定目录时先给 UID 1000 写权限，SQLite 数据卷使用支持本地文件锁的存储。不要与其他服务共用数据卷。容器端口由 `LEXYN_PORT` 配置，宿主端口由 `LEXYN_HOST_PORT` 配置，默认仅映射到宿主回环。

## HTTPS 反向代理

浏览器 → NAS HTTPS → `http://127.0.0.1:3000`（或 Compose 内网中的 Lexyn 服务）。将路径、查询、请求方法、请求体、Origin 与 Set-Cookie 正常转发。`LEXYN_PUBLIC_ORIGIN` 必须精确匹配公开 HTTPS origin，非默认端口也必须包含在内。应用忽略外部转发 Host/Proto，并继续要求 Owner 身份和精确 Origin。不同主机上的代理应通过可信内网接口或专用 Docker 网络连接，避免对公网直接映射容器端口。

代理需将应用部署在域名根路径，不要给 Manifest、Worker 或图标添加登录跳转。保留 `Cache-Control`；API 不应缓存。检查 `/library`、`/learn`、`/review`、`/settings` 深层链接刷新正常，并执行 `node scripts/check-proxy.mjs https://lexyn.example.invalid`。状态码、MIME、Location、缓存和响应体诊断见 [PWA 指南](pwa.md)。生产配置缺少合法 HTTPS origin 时服务会拒绝启动。

## 升级、备份与回滚

1. 用运行中的旧容器创建并验证 SQLite 备份，把备份复制到数据卷之外。
2. 将 `LEXYN_IMAGE` 更新为目标版本或 digest，执行 `pull` 和 `up -d`。保持同一个数据卷和公开 origin。检查健康、Owner 登录和两台设备登录后访问同一份词库，再做离线启动检查。
3. 页面提示更新时，完成当前操作后关闭所有 Lexyn 窗口再重新打开。不要清理站点数据来切换版本。
4. 若回滚且数据库结构仍兼容，可切换镜像 digest。已通过 Phase 6 备份命令恢复的数据库应继续使用支持恢复代次的版本。涉及数据库恢复时按 [备份与恢复](backup-restore.md) 使用兼容版本和维护命令，保留新旧数据库及原浏览器数据。切换或回滚后重新执行 HTTPS 检查。

## 发布验证

普通 CI 安装依赖、运行类型检查、Vitest、构建和完整 Playwright。版本 Tag 触发独立 Release workflow，对同一提交重跑 CI，然后构建 amd64 正式镜像。容器烟测通过后才推送 GHCR；已有版本标签会拒绝覆盖，Actions Summary 输出 digest。工作流只发布经过运行验证的 amd64 镜像。

在本机对同一正式镜像做验证：

```sh
docker build --platform linux/amd64 -t lexyn:local .
node scripts/container-smoke.mjs lexyn:local
```

烟测包括 TLS 反代、Owner Cookie、鉴权、写入、在线备份、重启、重建容器和持久化卷。NAS 首次正式验收还要检查其实际反代、证书、备份目录权限、设备安装入口、系统软键盘、手势安全区域和系统 TTS。建议用桌面、手机和目标 Android 平板逐一完成首次安装、断网打开应用壳、恢复联网后的评分与备份恢复演练。
