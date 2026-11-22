# web-terminal

浏览器里的终端：多账号登录与会话隔离，可绑定对应系统用户启动常驻 shell。服务端是 Node（Hono + ws + node-pty），客户端是不带框架的 TypeScript + xterm.js。用户是作者本人和朋友，会推荐给别人自己部署，所以默认体验要开箱即好。

## 命令

- `npm run check` 类型检查（服务端 + 客户端）
- `npm test` 服务端单元测试
- `npm run build` 打包客户端到 `client/dist`
- `npm start` 启动，只监听 127.0.0.1
- `node tools/test-selection.mjs` 用 ChromeDriver 验证已构建的客户端

Node 直接跑 `.ts`（类型擦除），服务端代码只能用可擦除的语法，导入要带 `.ts` 后缀。

## 结构

- `server/host.ts` shell 宿主，单独的进程和 systemd 单元（`web-terminal-host`），持有全部 shell。网页服务经数据目录里的 Unix 套接字（`var/host.sock`）调它：HTTP 管列表、新建、改名、关闭，每个浏览器连接对应一条到宿主的 WebSocket，`server/host-client.ts` 原样转发帧。网页服务重启不会结束 shell，浏览器重连后拿到新快照。
- `server/terminal.ts` shell 会话，跑在宿主里。每个会话有一份无头 xterm 镜像，浏览器接入时发一帧 JSON 快照（屏幕、回滚、光标、模式），之后才是二进制实时输出。不要退回成原始字节回放：那会从转义序列中间开始、丢掉备用屏和鼠标模式，还会让旧的查询序列被重复应答。
- `server/app.ts` 登录和终端管理 API。`server/main.ts` 校验 WebSocket 握手并交给宿主。`server/auth.ts` 管理 scrypt 密码、签名 cookie 和登录会话的终端归属。`server/assets.ts` 预压缩并提供已构建的客户端。
- `server/workspaces.ts` 保存按账号归属的会话目录，沿用既有登录的 shell 宿主归属键。创建终端和删除会话按会话串行处理。
- `server/file-routes.ts` 校验会话与账号后发送文件操作。`server/files.ts` 以对应 shell 用户的身份启动 `server/file-worker.ts`。上传和下载通过流传输，上传写完才在目标目录发布文件。
- `client/shell.ts` 一个标签页：xterm、WebGL 渲染、键盘处理、重连。页面打开时所有标签都连上（后台标签才能报状态），切到后台时不销毁，也不参与尺寸计算。
- `client/activity.ts` 后台标签的状态：运行中（转圈）、完成（强调色点）、等你确认（会呼吸的红点）。依据是 OSC 9;4 进度、通知（OSC 9/777/99、响铃）和输出节奏：持续输出算运行，停下 3 秒算结束，单次重绘（tmux 时钟）不算；结束后看屏幕末尾有没有各家 agent 的确认提示，来区分完成和等你。只在客户端做，不碰宿主。
- `client/ime.ts` 输入法、语音输入、手机键盘这类经 textarea 进来的文字。xterm 自带的几条路径（组字结束、insertText、keydown 229 后的差分）在部分输入法下会把同一段话各发一次，所以全部拦下，只按 textarea 相对上次发送的增删发一次。例外是空格、大写字母、死键：xterm 在 keypress 里已经发出，浏览器随后写进 textarea 的同一个字只记下不再发；不要改成拦下 keypress 交给 textarea 发。组字预览也在这里，会换行。
- `client/text-selection.ts` 处理开启鼠标上报后的鼠标拖选。单击仍交给程序，拖动交给 xterm 的选区处理。例外是连鼠标移动都上报的程序（1003，如 Claude Code 的全鼠标模式）：拖动整段交给程序自己选，因为松手后的移动上报算用户输入，会把 xterm 的选区清掉。
- `client/touch-scroll.ts` 区分轻点、长按、选区拖动和惯性滚动。普通 shell 滚动本地历史，全屏程序沿用 xterm 的滚轮处理，保留鼠标编码和方向键模式。
- `client/touch-selection.ts` 用 xterm 公共缓冲区和选区 API 实现长按选词、手柄、贴边滚动和复制。触屏操作条保持在选区附近，剪贴板写入失败时显示原生可选文本。保持触点事件与写入剪贴板在同一用户手势里。
- `client/themes.ts` 主题。调色板必须如实：黑是深色、白是浅色，浅色主题也一样。可读性靠 `minimumContrastRatio`，不靠把颜色对调。
- `client/settings.ts` 设置的存取和原生 dialog 面板。`client/i18n.ts` 中英文案。
- `client/workspaces.ts` 是终端区域内的会话管理列表。`client/main.ts` 将每个标签页选中的会话保存在 sessionStorage，终端请求和 WebSocket 显式携带所需的会话标识。
- `client/files.ts` 是终端区域内的远程文件管理器。下载走附件链接，上传直接提交文件数据。同名替换和删除需要在界面上确认。
- `client/dom.ts` 节点协调、点击期间的更新延迟，以及需要保留终端焦点和用户激活状态的触屏点击处理。标签和主题控件保留原节点，避免后台更新打断点击、双击和焦点。
- `client/fonts/` 两个回退字体由 `tools/subset-fonts.py` 生成，不手改。

## 约定

- 协议：客户端到服务端，二进制帧是按键，文本帧是 JSON 控制消息（`resize`）；服务端到客户端，文本帧是 JSON（`snapshot`、`title`），二进制帧是输出。
- cookie 为每个已登录账号维护一个签名令牌，各账号以 `~` 分隔。改密码后该账号的令牌在后续 HTTP 请求和 WebSocket 握手时失效，续签则保留原有登录标识。浏览器可以通过设置登录多个账号，标签栏汇总这些登录会话的终端。`+` 在只登录一个账号时直接新建，登录多个时在终端区域铺开账号选择（数字键选、Esc 返回，焦点默认在当前标签的账号）。不要做按配置免密切换到别的账号。
- 独立登录各自进入默认会话。当前账号可以显式切换到该账号的其他会话，各浏览器标签页独立选择。网页侧按账号验证归属，宿主继续用不透明的归属键校验终端访问。切换会话时断开旧视图，shell 仍由宿主持有。每个会话各自应用 `WEB_TERMINAL_MAX` 上限。
- 字符宽度两端都用 Unicode 11，改一端必须改另一端，否则回放时宽字符错位。
- 页面没有自己的配色，全部取自当前终端主题（`main.ts` 的 `paintChrome`）。
- 安全策略是 `font-src 'self'`，所以 Vite 不内联任何资源（`assetsInlineLimit: 0`）。
- 界面文案不加标点，中英文都要补。
- 选中标签的底板是标签栏里单独的一个节点（`.tab-ink`），位置由 `main.ts` 的 `placeInk` 按选中标签量出来：重绘标签时滑过去，标签只是变宽时直接跟上。动效只回应用户操作，`prefers-reduced-motion` 下全部关闭。
- 控件不画描边方框：凹槽用 `--field`，里面抬起的那一块用 `--raised`。深浅主题的差异写在 `:root.dark` 里（`paintChrome` 打标），不用 `light-dark()`：带 `var()` 的声明在旧浏览器里没有回退，会整条失效。
- 控件不要随状态更新整块重建。重命名失焦保存不得抢走下一次点击的焦点。按键栏修饰键只处理用户输入，不处理终端的查询应答。
- 不要另起一个实例换端口再切反代来"无中断上线"：标签只存在各自宿主的内存里，切过去旧标签全看不见。

## 文件管理协议

文件请求位于 `/api/files` 下，使用同一个登录 cookie。每次请求都按 `account` 从当前已登录账号中取系统用户。写入请求经过现有的同源校验。操作路径和权限由网页服务启动的文件子进程处理。

| 请求 | 参数和结果 |
|---|---|
| `GET /api/files` | 查询参数为 `account`、可选绝对 `path`、`offset` 和 `hidden=1`。省略路径时列出该系统用户的主目录，每页最多 160 项 |
| `GET /api/files/download` | 查询参数为 `account`、目录 `path` 和文件 `name`。普通文件以二进制附件流返回 |
| `POST /api/files/upload` | 查询参数为 `account`、目录 `path`、文件 `name` 和字节数 `size`。请求体为原始文件数据，用户确认替换后加 `replace=1` |
| `POST /api/files/folders` | JSON 请求体带 `account`、目录 `path` 和新目录 `name` |
| `PATCH /api/files/item` | JSON 请求体带 `account`、目录 `path`、`name` 和新名称 `to` |
| `DELETE /api/files/item` | JSON 请求体带 `account`、目录 `path` 和 `name`。目录删除会递归处理内容 |

文件子进程先在标准输出写一行 JSON，下载时在后面接文件字节。上传先写入同目录的私有临时文件，确认收到全部字节后用硬链接安装新文件，得到明确的替换请求时用重命名覆盖。同名上传返回 409，由客户端提供替换和跳过选项。协议类型在 `shared/files.ts`。

## 发布和验证

- 公开仓库是 `lemonhub-io/web-terminal`。GitHub Actions 从锁文件构建并上传 `web-terminal-client`，再用手机尺寸的 Chromium 触屏模拟验证会话切换、触屏选取与复制、文件目录导航和下载链接。
- 文件接口的定向测试是 `node --test --test-concurrency=1 server/test/files.test.ts`，覆盖账号鉴权、文件操作、二进制往返和同名上传保护。
- 客户端发布使用对应提交的成功构建产物，按 [README 的发布流程](README.md#client-builds-from-github-actions) 替换 `client/dist` 并 reload 网页服务。浏览器在下次加载页面时取得新资源。
- 改网页服务端时 restart 网页服务，浏览器会重连接到现有 shell。改宿主代码或配置时才重启宿主。宿主重启结束所有 shell，操作前先向使用者确认。
- 验证针对改动可能引入的具体问题。字体、符号、布局和触屏交互用对应的浏览器场景。纯文档改动直接审阅内容。
