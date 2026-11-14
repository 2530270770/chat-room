# 回声 · 简易网页聊天室

一个使用 Node.js 原生模块实现的实时网页聊天室。前端使用原生 HTML / CSS / JavaScript，后端使用 **HTTP + Server-Sent Events（SSE）**，不需要安装任何第三方依赖，也不需要数据库。

> 想把聊天室发布到公网并申请免费网址/域名？请看：[免费域名与部署教程](docs/免费域名与部署教程.md)。

## 功能

- 4 个聊天频道：大厅、技术角、摸鱼区、音乐台
- 无需注册，设置昵称即可进入
- 多窗口实时消息同步，自动重连
- 在线人数与在线成员头像
- 最近 100 条频道消息（保存在服务器内存中）
- 昵称、最后访问频道保存在浏览器 `localStorage`
- Emoji 选择器、消息字数提示、日期分隔、自动滚动
- 一键复制带频道参数的邀请链接
- 桌面端和手机端响应式布局
- 基础输入校验、频率限制与安全响应头

## 本地运行

需要 **Node.js 18 或更高版本**。

```powershell
cd "D:\desktop\gitee\聊天室"
npm start
```

浏览器打开：<http://localhost:3000>

项目没有任何第三方运行依赖，因此不需要执行 `npm install`。调试时可以使用：

```powershell
npm run dev
```

`npm run dev` 会使用 Node.js 的 `--watch` 自动重启服务。

### 修改端口

默认端口是 `3000`。可以通过环境变量覆盖：

```powershell
$env:PORT = 8080
npm start
```

也可以设置 `HOST`，默认监听所有网卡（`0.0.0.0`）。

> 不能直接双击打开 `public/index.html`。实时消息、历史记录和昵称校验都依赖 Node.js 服务端。

## 使用方式

1. 首次打开页面时输入昵称，昵称会保存在当前浏览器。
2. 在左侧切换频道；地址栏会带有 `?room=tech` 这样的频道参数。
3. `Enter` 发送消息，`Shift + Enter` 换行。
4. 点击「邀请朋友」复制当前频道的链接。
5. 点击左下角昵称旁的编辑按钮可以修改昵称。

在同一台机器上打开两个不同浏览器（或普通窗口 + 无痕窗口），即可测试实时聊天和在线人数。

## 部署到公网

项目已经包含 `render.yaml`，推荐使用 [Render](https://render.com/) 的免费 Web Service 做小范围演示：

1. 把项目推送到 GitHub。
2. 在 Render 新建 Blueprint 或 Web Service，选择该仓库。
3. 构建命令：`npm install`；启动命令：`npm start`；健康检查：`/health`。
4. 选择 Free 套餐并部署，成功后即可获得 `https://<服务名>.onrender.com` 形式的免费网址。

详细步骤、免费二级域名申请、Cloudflare Tunnel 临时公网网址和排错方法都在：

**[docs/免费域名与部署教程.md](docs/免费域名与部署教程.md)**

### 部署注意事项

- Render 会自动注入 `PORT`，不要写死部署端口。
- 免费实例闲置后可能休眠，下一次访问会有冷启动等待。
- 免费实例重启或重新部署后，内存中的消息会清空。
- 免费套餐和域名政策会调整，请以平台当前页面为准。
- 该项目的 SSE 需要 Node.js 运行环境；GitHub Pages 这类纯静态托管无法提供后端。

## 项目结构

```text
聊天室/
├─ public/
│  ├─ index.html          # 页面结构
│  ├─ styles.css          # 响应式界面样式
│  ├─ app.js              # 前端频道、消息、SSE 与交互逻辑
│  └─ favicon.svg
├─ test/
│  └─ server.test.js      # Node.js 内置测试
├─ docs/
│  └─ 免费域名与部署教程.md
├─ server.js              # HTTP 服务、API、SSE、内存消息存储
├─ render.yaml            # Render 部署配置
├─ package.json
└─ README.md
```

## 技术说明

这段聊天室刻意没有引入 WebSocket 库：

- 浏览器用 `EventSource` 订阅 `/api/events`
- 发消息用普通 `POST /api/messages`
- 服务端广播 SSE 事件，并在每 20 秒发送心跳
- `EventSource` 自带断线重连，适合免费平台和简单部署
- 前端用 `textContent` 渲染用户内容，不插入 HTML，避免 XSS

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/config` | 频道和长度限制 |
| `GET` | `/api/history?room=lobby` | 获取频道最近消息 |
| `GET` | `/api/events?room=lobby&name=小林&cid=...` | SSE 实时事件 |
| `POST` | `/api/messages` | 发送消息 |

发送消息的请求体：

```json
{
  "room": "lobby",
  "name": "小林",
  "clientId": "由浏览器生成的随机标识",
  "text": "大家好！"
}
```

## 测试

使用 Node.js 内置测试运行器：

```powershell
npm test
```

测试会覆盖健康检查、频道配置、SSE 实时消息、历史记录以及非法输入。

## 数据与限制

- 每个频道最多保留 **100 条**消息。
- 昵称最多 **16 个字符**，消息最多 **500 个字符**。
- 每个客户端 5 秒内最多发送 8 条消息。
- 消息保存在服务器进程内存中，不落盘、不共享给其他实例。
- 没有登录、身份认证、内容审核、文件上传和私聊功能。
- 任何拿到网址的人都可以进入聊天室，请不要发送隐私或敏感信息。

## 正式上线前建议

如果这个聊天室不只是朋友间的小工具，建议继续补充：

- 账号登录与昵称占用控制
- 数据库持久化（SQLite / PostgreSQL）
- 消息审核、举报、禁言和管理后台
- 更严格的限流与 CSRF/Origin 校验
- 多实例部署时使用 Redis 等共享发布订阅
- 隐私政策、服务条款和数据删除机制

当前版本定位是：**代码可读、可直接运行、适合学习和小范围演示的简易聊天室**。
