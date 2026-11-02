---
name: agent-browser
description: 面向 AI agent 的浏览器自动化 CLI。当用户需要与网站交互时使用，包括导航页面、填写表单、点击按钮、截图、提取数据、测试 Web 应用，或自动化任何浏览器任务。触发场景包括“打开某个网站”“填写表单”“点击按钮”“截图”“从页面抓取数据”“测试这个 Web 应用”“登录某个站点”“自动化浏览器操作”等请求，以及任何需要以编程方式与 Web 交互的任务。
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*)
---

# 使用 agent-browser 进行浏览器自动化

该 CLI 通过 CDP 直接使用 Chrome/Chromium。可通过 `npm i -g agent-browser`、`brew install agent-browser` 或 `cargo install agent-browser` 安装。运行 `agent-browser install` 下载 Chrome。已安装的 Chrome、Brave、Playwright 和 Puppeteer 会被自动检测。运行 `agent-browser upgrade` 可更新到最新版本。

## 核心工作流

每个浏览器自动化任务都遵循以下模式：

1. **导航**：`agent-browser open <url>`
2. **快照**：`agent-browser snapshot -i`（获取形如 `@e1`、`@e2` 的元素引用）
3. **交互**：使用引用进行点击、填写、选择
4. **重新快照**：导航或 DOM 变化后，重新获取引用

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait 2000
agent-browser snapshot -i  # Check result
```

## 命令串联

命令可以在单次 shell 调用中用 `&&` 串联。浏览器通过后台守护进程在命令之间保持状态，因此串联是安全的，且比分多次调用更高效。

```bash
# Chain open + snapshot in one call (open already waits for page load)
agent-browser open https://example.com && agent-browser snapshot -i

# Chain multiple interactions
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3

# Navigate and capture
agent-browser open https://example.com && agent-browser screenshot
```

**何时串联：** 当你不需要先读取中间命令的输出就能继续时（例如 open + wait + screenshot），使用 `&&`。当你需要先解析输出时（例如先用 snapshot 发现引用，再用这些引用进行交互），请分开运行命令。

## 处理认证

在自动化需要登录的站点时，选择适合的方式：

**方案 1：从用户浏览器导入认证状态（一次性任务最快）**

```bash
# Connect to the user's running Chrome (they're already logged in)
agent-browser --auto-connect state save ./auth.json
# Use that auth state
agent-browser --state ./auth.json open https://app.example.com/dashboard
```

状态文件以明文形式包含会话令牌——请将其加入 `.gitignore`，并在不再需要时删除。设置 `AGENT_BROWSER_ENCRYPTION_KEY` 可启用静态加密。

**方案 2：复用 Chrome 用户配置（零配置）**

```bash
# List available Chrome profiles
agent-browser profiles

# Reuse the user's existing Chrome login state
agent-browser --profile Default open https://gmail.com
```

**方案 3：持久化配置目录（适用于周期性任务）**

```bash
# First run: login manually or via automation
agent-browser --profile ~/.myapp open https://app.example.com/login
# ... fill credentials, submit ...

# All future runs: already authenticated
agent-browser --profile ~/.myapp open https://app.example.com/dashboard
```

**方案 4：会话名称（自动保存/恢复 cookies 和 localStorage）**

```bash
agent-browser --session-name myapp open https://app.example.com/login
# ... login flow ...
agent-browser close  # State auto-saved

# Next time: state auto-restored
agent-browser --session-name myapp open https://app.example.com/dashboard
```

**方案 5：认证保管库（凭据加密存储，按名称登录）**

```bash
echo "$PASSWORD" | agent-browser auth save myapp --url https://app.example.com/login --username user --password-stdin
agent-browser auth login myapp
```

`auth login` 以 `load` 策略导航，然后等待登录表单选择器出现后再填写/点击，这在延迟渲染的 SPA 登录页面上更可靠。

**方案 6：状态文件（手动保存/加载）**

```bash
# After logging in:
agent-browser state save ./auth.json
# In a future session:
agent-browser state load ./auth.json
agent-browser open https://app.example.com/dashboard
```

关于 OAuth、2FA、基于 cookie 的认证以及令牌刷新模式，参见 [references/authentication.md](references/authentication.md)。

## 常用命令

```bash
# Batch: ALWAYS use batch for 2+ sequential commands. Commands run in order.
agent-browser batch "open https://example.com" "snapshot -i"
agent-browser batch "open https://example.com" "screenshot"
agent-browser batch "click @e1" "wait 1000" "screenshot"

# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser close                   # Close browser
agent-browser close --all             # Close all active sessions

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i --urls      # Include href URLs for links
agent-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press key
agent-browser keyboard type "text"    # Type at current focus (no selector)
agent-browser keyboard inserttext "text"  # Insert without key events
agent-browser scroll down 500         # Scroll page
agent-browser scroll down 500 --selector "div.content"  # Scroll within a specific container

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title
agent-browser get cdp-url             # Get CDP WebSocket URL

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait 2000               # Wait milliseconds
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait --text "Welcome"   # Wait for text to appear (substring match)
agent-browser wait --load networkidle # Wait for network idle (caution: see Pitfalls)
agent-browser wait --fn "!document.body.innerText.includes('Loading...')"  # Wait for text to disappear
agent-browser wait "#spinner" --state hidden  # Wait for element to disappear

# Downloads
agent-browser download @e1 ./file.pdf          # Click element to trigger download
agent-browser wait --download ./output.zip     # Wait for any download to complete
agent-browser --download-path ./downloads open <url>  # Set default download directory

# Tab management
agent-browser tab list                         # List all open tabs
agent-browser tab new                          # Open a blank new tab
agent-browser tab new https://example.com      # Open URL in a new tab
agent-browser tab 2                            # Switch to tab by index (0-based)
agent-browser tab close                        # Close the current tab
agent-browser tab close 2                      # Close tab by index

# Network
agent-browser network requests                 # Inspect tracked requests
agent-browser network requests --type xhr,fetch  # Filter by resource type
agent-browser network requests --method POST   # Filter by HTTP method
agent-browser network requests --status 2xx    # Filter by status (200, 2xx, 400-499)
agent-browser network request <requestId>      # View full request/response detail
agent-browser network route "**/api/*" --abort  # Block matching requests
agent-browser network har start                # Start HAR recording
agent-browser network har stop ./capture.har   # Stop and save HAR file

# Viewport & Device Emulation
agent-browser set viewport 1920 1080          # Set viewport size (default: 1280x720)
agent-browser set viewport 1920 1080 2        # 2x retina (same CSS size, higher res screenshots)
agent-browser set device "iPhone 14"          # Emulate device (viewport + user agent)

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser screenshot --screenshot-dir ./shots  # Save to custom directory
agent-browser screenshot --screenshot-format jpeg --screenshot-quality 80
agent-browser pdf output.pdf          # Save as PDF

# Live preview / streaming
agent-browser stream enable           # Start runtime WebSocket streaming on an auto-selected port
agent-browser stream enable --port 9223  # Bind a specific localhost port
agent-browser stream status           # Inspect enabled state, port, connection, and screencasting
agent-browser stream disable          # Stop runtime streaming and remove the .stream metadata file

# Clipboard
agent-browser clipboard read                      # Read text from clipboard
agent-browser clipboard write "Hello, World!"     # Write text to clipboard
agent-browser clipboard copy                      # Copy current selection
agent-browser clipboard paste                     # Paste from clipboard

# Dialogs (alert, confirm, prompt, beforeunload)
# By default, alert and beforeunload dialogs are auto-accepted so they never block the agent.
# confirm and prompt dialogs still require explicit handling.
# Use --no-auto-dialog (or AGENT_BROWSER_NO_AUTO_DIALOG=1) to disable automatic handling.
agent-browser dialog accept              # Accept dialog
agent-browser dialog accept "my input"   # Accept prompt dialog with text
agent-browser dialog dismiss             # Dismiss/cancel dialog
agent-browser dialog status              # Check if a dialog is currently open

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --wait-until networkidle  # Custom wait strategy
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element

# Chat (AI natural language control)
agent-browser chat "open google.com and search for cats"  # Single-shot instruction
agent-browser chat                                        # Interactive REPL mode
agent-browser -q chat "summarize this page"               # Quiet (text only, no tool calls)
agent-browser -v chat "fill in the login form"            # Verbose (show command output)
agent-browser --model openai/gpt-4o chat "take a screenshot"  # Override model
```

## 流式传输

每个会话都会自动在操作系统分配的端口上启动一个 WebSocket 流服务器。使用 `agent-browser stream status` 查看绑定的端口和连接状态。使用 `stream disable` 将其关闭，使用 `stream enable --port <port>` 在指定端口上重新启用。

## 批量执行

按顺序运行 2 个及以上命令时，务必使用 `batch`。Batch 按顺序执行命令，因此有依赖关系的命令（例如先导航再截图）可以正确工作。每个带引号的参数都是一条独立命令。

```bash
# Navigate and take a snapshot
agent-browser batch "open https://example.com" "snapshot -i"

# Navigate, snapshot, and screenshot in one call
agent-browser batch "open https://example.com" "snapshot -i" "screenshot"

# Click, wait, then screenshot
agent-browser batch "click @e1" "wait 1000" "screenshot"

# With --bail to stop on first error
agent-browser batch --bail "open https://example.com" "click @e1" "screenshot"
```

只有在需要读取输出后才能决定下一条命令时，才使用单条命令（而非 batch）。例如，当你需要读取引用来决定点击哪个元素时，必须将 `snapshot -i` 作为单条命令运行。读取快照后，再将其余步骤放入 batch。

也支持 stdin 模式，便于程序化调用：

```bash
echo '[["open","https://example.com"],["screenshot"]]' | agent-browser batch --json
agent-browser batch --bail < commands.json
```

## 效率策略

这些模式可以最大限度地减少工具调用次数和 token 消耗。

**使用 `--urls` 避免重复导航。** 当需要访问页面中的链接时，使用 `snapshot -i --urls` 一次性获取所有 href URL。然后直接 `open` 每个 URL，而不是点击引用后再导航回来。

**一次快照，多次操作。** 绝不要对同一页面重复快照。从一次快照中提取所有需要的信息（引用、URL、文本），然后将其余操作批量执行。

**多页面工作流（例如“访问 N 个站点并分别截图”）：**

```bash
# 1. Get all URLs in one call
agent-browser batch "open https://news.ycombinator.com" "snapshot -i --urls"
# Read output to extract URLs, then visit each directly:
# 2. One batch per target site
agent-browser batch "open https://github.com/example/repo" "screenshot"
agent-browser batch "open https://example.com/article" "screenshot"
agent-browser batch "open https://other.com/page" "screenshot"
```

这种方法使用 4 次工具调用，而不是 14 次以上。绝不要在两次访问之间返回列表页。

## 常见模式

### 表单提交

```bash
# Navigate and get the form structure
agent-browser batch "open https://example.com/signup" "snapshot -i"
# Read the snapshot output to identify form refs, then fill and submit
agent-browser batch "fill @e1 \"Jane Doe\"" "fill @e2 \"jane@example.com\"" "select @e3 \"California\"" "check @e4" "click @e5" "wait 2000"
```

### 使用认证保管库进行认证（推荐）

```bash
# Save credentials once (encrypted with AGENT_BROWSER_ENCRYPTION_KEY)
# Recommended: pipe password via stdin to avoid shell history exposure
echo "pass" | agent-browser auth save github --url https://github.com/login --username user --password-stdin

# Login using saved profile (LLM never sees password)
agent-browser auth login github

# List/show/delete profiles
agent-browser auth list
agent-browser auth show github
agent-browser auth delete github
```

`auth login` 在交互之前会等待用户名/密码/提交选择器出现，其超时时间与默认操作超时时间一致。

### 使用状态持久化进行认证

```bash
# Login once and save state
agent-browser batch "open https://app.example.com/login" "snapshot -i"
# Read snapshot to find form refs, then fill and submit
agent-browser batch "fill @e1 \"$USERNAME\"" "fill @e2 \"$PASSWORD\"" "click @e3" "wait --url **/dashboard" "state save auth.json"

# Reuse in future sessions
agent-browser batch "state load auth.json" "open https://app.example.com/dashboard"
```

### 会话持久化

```bash
# Auto-save/restore cookies and localStorage across browser restarts
agent-browser --session-name myapp open https://app.example.com/login
# ... login flow ...
agent-browser close  # State auto-saved to ~/.agent-browser/sessions/

# Next time, state is auto-loaded
agent-browser --session-name myapp open https://app.example.com/dashboard

# Encrypt state at rest
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
agent-browser --session-name secure open https://app.example.com

# Manage saved states
agent-browser state list
agent-browser state show myapp-default.json
agent-browser state clear myapp
agent-browser state clean --older-than 7
```

### 处理 Iframe

Iframe 的内容会自动内联到快照中。Iframe 内的引用带有 frame 上下文，因此可以直接与之交互。

```bash
agent-browser batch "open https://example.com/checkout" "snapshot -i"
# @e1 [heading] "Checkout"
# @e2 [Iframe] "payment-frame"
#   @e3 [input] "Card number"
#   @e4 [input] "Expiry"
#   @e5 [button] "Pay"

# Interact directly — no frame switch needed
agent-browser batch "fill @e3 \"4111111111111111\"" "fill @e4 \"12/28\"" "click @e5"

# To scope a snapshot to one iframe:
agent-browser batch "frame @e2" "snapshot -i"
agent-browser frame main          # Return to main frame
```

### 数据提取

```bash
agent-browser batch "open https://example.com/products" "snapshot -i"
# Read snapshot to find element refs, then extract
agent-browser get text @e5           # Get specific element text

# JSON output for parsing
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

### 并行会话

```bash
agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com

agent-browser --session site1 snapshot -i
agent-browser --session site2 snapshot -i

agent-browser session list
```

### 连接到现有 Chrome

```bash
# Auto-discover running Chrome with remote debugging enabled
agent-browser --auto-connect open https://example.com
agent-browser --auto-connect snapshot

# Or with explicit CDP port
agent-browser --cdp 9222 snapshot
```

自动连接会通过 `DevToolsActivePort`、常见调试端口（9222、9229）发现 Chrome；如果基于 HTTP 的 CDP 发现失败，则会回退为直接建立 WebSocket 连接。

### 配色方案（深色模式）

```bash
# Persistent dark mode via flag (applies to all pages and new tabs)
agent-browser --color-scheme dark open https://example.com

# Or via environment variable
AGENT_BROWSER_COLOR_SCHEME=dark agent-browser open https://example.com

# Or set during session (persists for subsequent commands)
agent-browser set media dark
```

### 视口与响应式测试

```bash
# Set a custom viewport size (default is 1280x720)
agent-browser set viewport 1920 1080
agent-browser screenshot desktop.png

# Test mobile-width layout
agent-browser set viewport 375 812
agent-browser screenshot mobile.png

# Retina/HiDPI: same CSS layout at 2x pixel density
# Screenshots stay at logical viewport size, but content renders at higher DPI
agent-browser set viewport 1920 1080 2
agent-browser screenshot retina.png

# Device emulation (sets viewport + user agent in one step)
agent-browser set device "iPhone 14"
agent-browser screenshot device.png
```

`scale` 参数（第 3 个参数）会设置 `window.devicePixelRatio`，但不改变 CSS 布局。在测试 retina 渲染或截取更高分辨率截图时使用它。

### 可视化浏览器（调试）

```bash
agent-browser --headed open https://example.com
agent-browser highlight @e1          # Highlight element
agent-browser inspect                # Open Chrome DevTools for the active page
agent-browser record start demo.webm # Record session
agent-browser profiler start         # Start Chrome DevTools profiling
agent-browser profiler stop trace.json # Stop and save profile (path optional)
```

可通过环境变量 `AGENT_BROWSER_HEADED=1` 启用有头模式。浏览器扩展在有头和无头模式下均可工作。

### 本地文件（PDF、HTML）

```bash
# Open local files with file:// URLs
agent-browser --allow-file-access open file:///path/to/document.pdf
agent-browser --allow-file-access open file:///path/to/page.html
agent-browser screenshot output.png
```

### iOS 模拟器（Mobile Safari）

```bash
# List available iOS simulators
agent-browser device list

# Launch Safari on a specific device
agent-browser -p ios --device "iPhone 16 Pro" open https://example.com

# Same workflow as desktop - snapshot, interact, re-snapshot
agent-browser -p ios snapshot -i
agent-browser -p ios tap @e1          # Tap (alias for click)
agent-browser -p ios fill @e2 "text"
agent-browser -p ios swipe up         # Mobile-specific gesture

# Take screenshot
agent-browser -p ios screenshot mobile.png

# Close session (shuts down simulator)
agent-browser -p ios close
```

**环境要求：** 安装 Xcode 的 macOS，以及 Appium（`npm install -g appium && appium driver install xcuitest`）

**真机：** 如果已预先配置，也可用于物理 iOS 设备。使用 `--device "<UDID>"`，其中 UDID 来自 `xcrun xctrace list devices`。

## 安全

所有安全功能均为按需开启（opt-in）。默认情况下，agent-browser 对导航、操作或输出不施加任何限制。

### 内容边界（推荐 AI agent 使用）

启用 `--content-boundaries` 可将来自页面的输出包裹在标记中，帮助 LLM 区分工具输出与不可信的页面内容：

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
agent-browser snapshot
# Output:
# --- AGENT_BROWSER_PAGE_CONTENT nonce=<hex> origin=https://example.com ---
# [accessibility tree]
# --- END_AGENT_BROWSER_PAGE_CONTENT nonce=<hex> ---
```

### 域名允许列表

将导航限制在可信域名内。像 `*.example.com` 这样的通配符也会匹配裸域名 `example.com`。指向非允许域名的子资源请求、WebSocket 和 EventSource 连接同样会被阻止。请把目标页面依赖的 CDN 域名也加入列表：

```bash
export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"
agent-browser open https://example.com        # OK
agent-browser open https://malicious.com       # Blocked
```

### 操作策略

使用策略文件来管控破坏性操作：

```bash
export AGENT_BROWSER_ACTION_POLICY=./policy.json
```

`policy.json` 示例：

```json
{ "default": "deny", "allow": ["navigate", "snapshot", "click", "scroll", "wait", "get"] }
```

认证保管库操作（如 `auth login` 等）会绕过操作策略，但域名允许列表仍然生效。

### 输出限制

防止大页面导致上下文泛滥：

```bash
export AGENT_BROWSER_MAX_OUTPUT=50000
```

## 差异比较（验证变更）

在执行操作后使用 `diff snapshot` 验证是否产生了预期效果。它会将当前可访问性树与本次会话中上一次的快照进行比较。

```bash
# Typical workflow: snapshot -> action -> diff
agent-browser snapshot -i          # Take baseline snapshot
agent-browser click @e2            # Perform action
agent-browser diff snapshot        # See what changed (auto-compares to last snapshot)
```

用于视觉回归测试或监控：

```bash
# Save a baseline screenshot, then compare later
agent-browser screenshot baseline.png
# ... time passes or changes are made ...
agent-browser diff screenshot --baseline baseline.png

# Compare staging vs production
agent-browser diff url https://staging.example.com https://prod.example.com --screenshot
```

`diff snapshot` 的输出使用 `+` 表示新增、`-` 表示移除，类似 git diff。`diff screenshot` 会生成一张差异图，变化的像素以红色高亮，并给出不匹配百分比。

## 超时与慢速页面

默认超时时间为 25 秒。可通过 `AGENT_BROWSER_DEFAULT_TIMEOUT` 环境变量覆盖（值以毫秒为单位）。

**重要：** `open` 在返回前已经等待了页面的 `load` 事件。大多数情况下，在截图或快照前不需要额外等待。只有当内容在页面初次加载后异步加载时，才需显式添加等待。

```bash
# Wait for a specific element to appear (preferred for dynamic content)
agent-browser wait "#content"
agent-browser wait @e1

# Wait a fixed duration (good default for slow SPAs)
agent-browser wait 2000

# Wait for a specific URL pattern (useful after redirects)
agent-browser wait --url "**/dashboard"

# Wait for text to appear on the page
agent-browser wait --text "Results loaded"

# Wait for a JavaScript condition
agent-browser wait --fn "document.querySelectorAll('.item').length > 0"
```

**避免使用 `wait --load networkidle`**，除非你确定该站点没有持续的网络活动。广告较多的站点、带有分析/跟踪的站点以及使用 websocket 的站点会导致 `networkidle` 无限挂起。建议改用 `wait 2000` 或 `wait <selector>`。

## JavaScript 对话框（alert / confirm / prompt）

当页面打开 JavaScript 对话框（`alert()`、`confirm()` 或 `prompt()`）时，它会阻塞所有其他浏览器命令（snapshot、screenshot、click 等），直到对话框被关闭。如果命令意外开始超时，请检查是否存在待处理的对话框：

```bash
# Check if a dialog is blocking
agent-browser dialog status

# Accept the dialog (dismiss the alert / click OK)
agent-browser dialog accept

# Accept a prompt dialog with input text
agent-browser dialog accept "my input"

# Dismiss the dialog (click Cancel)
agent-browser dialog dismiss
```

当有对话框待处理时，所有命令响应都会包含一个 `warning` 字段，指明对话框类型和消息。在 `--json` 模式下，该信息会以响应对象中的 `"warning"` 键出现。

## 会话管理与清理

在并发运行多个 agent 或自动化任务时，务必使用命名会话以避免冲突：

```bash
# Each agent gets its own isolated session
agent-browser --session agent1 open site-a.com
agent-browser --session agent2 open site-b.com

# Check active sessions
agent-browser session list
```

完成后务必关闭浏览器会话，以避免进程泄漏：

```bash
agent-browser close                    # Close default session
agent-browser --session agent1 close   # Close specific session
agent-browser close --all              # Close all active sessions
```

如果之前的会话未正常关闭，守护进程可能仍在运行。使用 `agent-browser close` 清理它，或使用 `agent-browser close --all` 一次性关闭所有会话。

要在空闲一段时间后自动关闭守护进程（适用于临时/CI 环境）：

```bash
AGENT_BROWSER_IDLE_TIMEOUT_MS=60000 agent-browser open example.com
```

## 引用生命周期（重要）

当页面发生变化时，引用（`@e1`、`@e2` 等）会失效。以下情况后务必重新快照：

- 点击会触发导航的链接或按钮
- 提交表单
- 动态内容加载（下拉菜单、模态框）

```bash
agent-browser click @e5              # Navigates to new page
agent-browser snapshot -i            # MUST re-snapshot
agent-browser click @e1              # Use new refs
```

## 标注截图（视觉模式）

使用 `--annotate` 截取一张在交互元素上叠加编号标签的截图。每个标签 `[N]` 对应引用 `@eN`。这还会缓存引用，因此你可以立即与元素交互，而无需单独执行快照。

```bash
agent-browser screenshot --annotate
# Output includes the image path and a legend:
#   [1] @e1 button "Submit"
#   [2] @e2 link "Home"
#   [3] @e3 textbox "Email"
agent-browser click @e2              # Click using ref from annotated screenshot
```

在以下情况下使用标注截图：

- 页面上有未标注的图标按钮或纯视觉元素
- 需要验证视觉布局或样式
- 存在 canvas 或图表元素（文本快照无法看到）
- 需要对元素位置进行空间推理

## 语义定位器（引用的替代方案）

当引用不可用或不可靠时，使用语义定位器：

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

## JavaScript 求值（eval）

使用 `eval` 在浏览器上下文中运行 JavaScript。**Shell 引号处理可能会破坏复杂表达式**——请使用 `--stdin` 或 `-b` 来避免问题。

```bash
# Simple expressions work with regular quoting
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'

# Complex JS: use --stdin with heredoc (RECOMMENDED)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF

# Alternative: base64 encoding (avoids all shell escaping issues)
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll("a")).map(a => a.href)' | base64)"
```

**为什么这很重要：** 当 shell 处理你的命令时，内层双引号、`!` 字符（历史展开）、反引号和 `$()` 都可能在 JavaScript 到达 agent-browser 之前将其破坏。`--stdin` 和 `-b` 标志可以完全绕过 shell 解释。

**经验法则：**

- 单行、无嵌套引号 -> 使用单引号的常规 `eval 'expression'` 即可
- 嵌套引号、箭头函数、模板字面量或多行 -> 使用 `eval --stdin <<'EVALEOF'`
- 程序化/生成的脚本 -> 使用 `eval -b` 配合 base64

## 配置文件

在项目根目录创建 `agent-browser.json` 以持久化配置：

```json
{
  "headed": true,
  "proxy": "http://localhost:8080",
  "profile": "./browser-data"
}
```

优先级（从低到高）：`~/.agent-browser/config.json` < `./agent-browser.json` < 环境变量 < CLI 标志。使用 `--config <path>` 或 `AGENT_BROWSER_CONFIG` 环境变量指定自定义配置文件（若文件缺失或无效则报错退出）。所有 CLI 选项都映射为 camelCase 键（例如 `--executable-path` -> `"executablePath"`）。布尔标志接受 `true`/`false` 值（例如 `--headed false` 会覆盖配置）。来自用户配置和项目配置的扩展会被合并，而非替换。

## 深入阅读文档

| 参考文档                                                             | 使用场景                               |
| -------------------------------------------------------------------- | ----------------------------------------- |
| [references/commands.md](references/commands.md)                     | 包含所有选项的完整命令参考                |
| [references/snapshot-refs.md](references/snapshot-refs.md)           | 引用生命周期、失效规则、故障排查          |
| [references/session-management.md](references/session-management.md) | 并行会话、状态持久化、并发抓取            |
| [references/authentication.md](references/authentication.md)         | 登录流程、OAuth、2FA 处理、状态复用        |
| [references/video-recording.md](references/video-recording.md)       | 用于调试和文档记录的录制工作流            |
| [references/profiling.md](references/profiling.md)                   | 用于性能分析的 Chrome DevTools 性能剖析    |
| [references/proxy-support.md](references/proxy-support.md)           | 代理配置、地域测试、轮换代理              |

## 云服务提供商

使用 `-p <provider>`（或 `AGENT_BROWSER_PROVIDER`）针对云端浏览器运行，而不是启动本地 Chrome 实例。支持的提供商：`agentcore`、`browserbase`、`browserless`、`browseruse`、`kernel`。

### AgentCore（AWS Bedrock）

```bash
# Credentials auto-resolved from env vars or AWS CLI (SSO, IAM roles, etc.)
agent-browser -p agentcore open https://example.com

# With persistent browser profile
AGENTCORE_PROFILE_ID=my-profile agent-browser -p agentcore open https://example.com

# With explicit region
AGENTCORE_REGION=eu-west-1 agent-browser -p agentcore open https://example.com
```

设置 `AWS_PROFILE` 以选择具名的 AWS 配置文件。

## 浏览器引擎选择

使用 `--engine` 选择本地浏览器引擎。默认为 `chrome`。

```bash
# Use Lightpanda (fast headless browser, requires separate install)
agent-browser --engine lightpanda open example.com

# Via environment variable
export AGENT_BROWSER_ENGINE=lightpanda
agent-browser open example.com

# With custom binary path
agent-browser --engine lightpanda --executable-path /path/to/lightpanda open example.com
```

支持的引擎：
- `chrome`（默认）—— 通过 CDP 使用 Chrome/Chromium
- `lightpanda` —— 通过 CDP 使用 Lightpanda 无头浏览器（比 Chrome 快 10 倍，内存占用低 10 倍）

Lightpanda 不支持 `--extension`、`--profile`、`--state` 或 `--allow-file-access`。请从 https://lightpanda.io/docs/open-source/installation 安装 Lightpanda。

## 可观测性面板

该面板是一个独立的常驻后台服务，可展示所有会话的实时浏览器视口、命令活动和控制台输出。

```bash
# Start the dashboard server (background, port 4848)
agent-browser dashboard start

# All sessions are automatically visible in the dashboard
agent-browser open example.com

# Stop the dashboard
agent-browser dashboard stop
```

面板独立于浏览器会话运行，监听端口 4848（可通过 `--port` 配置）。所有会话都会自动串流到面板。也可以从面板 UI 中使用本地引擎或云服务提供商创建会话。

### 面板 AI 对话

面板有一个可选的 AI 对话标签页，由 Vercel AI Gateway 提供支持。通过设置以下内容启用：

```bash
export AI_GATEWAY_API_KEY=gw_your_key_here
export AI_GATEWAY_MODEL=anthropic/claude-sonnet-4.6           # optional default
export AI_GATEWAY_URL=https://ai-gateway.vercel.sh           # optional default
```

对话标签页在面板中始终可见。设置 `AI_GATEWAY_API_KEY` 以启用 AI 响应。

## 即用模板

| 模板                                                                     | 描述                                 |
| ------------------------------------------------------------------------ | ----------------------------------- |
| [templates/form-automation.sh](templates/form-automation.sh)             | 带校验的表单填写                    |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) | 登录一次，复用状态                  |
| [templates/capture-workflow.sh](templates/capture-workflow.sh)           | 结合截图的内容提取                  |

```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
