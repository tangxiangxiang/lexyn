# Lexyn PWA

正式构建提供根范围的 Web App Manifest、192/512 PNG、独立 maskable PNG 和 SVG favicon。Android Chrome 的「安装应用」入口由浏览器决定。生产必须使用有效 HTTPS；本地验证可使用回环地址。Vite 开发服务器不注册 Service Worker。

首次在线访问时，Service Worker 先完整下载应用壳，再接管页面。`npm run build` 用静态文件内容生成缓存版本，包含 Vite 构建的 JS、CSS、应用壳、Manifest 和图标。安装时要求资源状态、MIME 和 SHA-256 均匹配，并拒绝重定向。导航使用同版本缓存的壳，避免切换部署期间混用 HTML 与脚本。Worker 只处理同源 GET 白名单和已知应用导航。`/api` 和 `/api/*` 保持网络请求；认证、词库、学习记录和 JSON 导出都只通过网络读取。

断网前先在线打开，等待 `navigator.serviceWorker.controller` 存在。在飞行模式下关闭所有 Lexyn 页面，再打开应用，检查静态壳、连接错误和 **Retry connection** 入口。联网后重试即可加载服务器上的业务数据。练习和评分必须由服务器确认后才会保存。

新版本先在后台完整预缓存，活跃页面继续用原版本。出现 **New version available** 后，完成当前输入或评分，关闭所有 Lexyn 标签页和独立窗口，再重新打开。浏览器随后启用新版，清理旧版应用壳。安装失败时旧 Worker 与旧缓存仍可用。

## 代理检查

从可访问 NAS HTTPS 域名的电脑运行 `node scripts/check-proxy.mjs https://lexyn.example.invalid`，替换为真实 origin。脚本禁止跟随跳转，逐项核对状态、MIME、Location、Cache-Control 与响应内容。Manifest、Worker 或图标返回 302、登录页、代理默认页或错误 MIME 时，检查代理路径和登录拦截规则。`/api/health` 应为 200 JSON；个人 API 自行验证 Owner。不要在 HTTPS 之外绕过浏览器的安全限制。
