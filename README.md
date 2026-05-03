# HTTP Client

轻量级、可视化的 API 调试工具 — 基于 Tauri v2 构建，集成了 HTTP 请求发送、DNS 查询、WHOIS 域名查询三大模块。

*程序由 DeepSeek V4 Pro 编写，总 Tokens：90,189,200*

---

## 功能

### 请求编辑

- 支持 GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS
- **URL 自动解析**：输入含 Query 的 URL 后，失焦时自动提取 `?key=val&...` 到 Params 表格
- URL Params 可视化 Key-Value 编辑，支持批量导入 `a=1&b=2`
- Headers 编辑，快捷头从 `headers.json` 动态加载（可自定义）
- **Content-Type 只读**：由 Body 类型自动接管，不可手动修改
- Body 全部模式：`none` / `form-data` / `x-www-form-urlencoded` / `json` / `binary` / `raw`
  - form-data / urlencoded 支持「KV 表格」和「原始文本」两种子模式
  - binary 支持「上传文件」和「原始数据」两种子模式
  - json 带实时语法高亮预览，raw 带可编辑 Content-Type（下拉选择或自由输入）
- 多标签页同时编辑多个请求，标签持久化

### 认证

- No Auth / Bearer Token / Basic Auth / API Key（Header 或 Query）

### 环境变量

- 多环境切换（Dev / Prod / Local / 自定义）
- `{{变量名}}` 占位符自动替换，请求前脚本可动态注入变量

### 请求前脚本

- JavaScript 沙箱执行，内置 `env` / `timestamp` / `random` / `url` / `method`
- 脚本错误不阻断发送

### 响应展示

- 状态码（彩色徽章）+ 耗时（ms）+ 大小（B/KB/MB）
- 响应头表格
- JSON / XML / HTML 语法高亮 + 可折叠/展开
- 图片 / PDF 内嵌预览
- 响应保存为本地文件、一键复制响应体

### 网络工具（右上角 `⋯` 菜单）

| 工具 | 说明 |
|------|------|
| **cURL 导出** | 将当前请求生成 cURL 命令并复制到剪贴板 |
| **cURL 导入** | 粘贴 cURL 命令自动填表 |
| **DNS 查询** | 查询 A / AAAA / MX / NS / TXT / CNAME / SOA 记录（`trust-dns-resolver`） |
| **WHOIS 查询** | 查询域名注册信息，自动解析结构化摘要（`whois-service`） |

### 历史记录

- 最近 100 条请求持久化，点击回填
- **相同 URL+方法自动去重**，保留最新
- 置顶 / 删除单条，清空时保留置顶项
- 窗口宽度 <750px 时侧边栏自动折叠，通过标签栏左侧按钮打开（带灰色遮罩层）

### 主题与界面

- 浅色 / 深色一键切换（SVG 图标），偏好持久化
- 请求区与响应区之间可拖拽分隔条，比例持久化
- 响应状态栏左侧显示保存/复制按钮，右侧显示状态信息

---

## 架构

| 层 | 技术 |
|----|------|
| 桌面容器 | Tauri v2 (Rust) |
| 前端 | 原生 HTML + CSS + JS，零框架 |
| HTTP 发送 | Rust 自定义 `fetch` 命令（reqwest），零 CORS 限制 |
| DNS 查询 | `trust-dns-resolver` 异步解析 A / AAAA / MX / NS / TXT / CNAME / SOA |
| WHOIS 查询 | `whois-service` 自动发现 WHOIS 服务器 + 结构化解析 + RDAP 回退 |
| 文件操作 | Tauri `plugin-dialog` + `plugin-fs` |
| 存储 | `localStorage` |

---

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发模式（热重载）
pnpm tauri dev

# 构建生产包
pnpm tauri build
```

---

## 项目结构

```
src/
├── index.html      # UI 结构
├── styles.css      # 样式 + 深浅主题变量 + 响应式媒体查询
├── main.js         # 全部业务逻辑（~1700 行）
├── headers.json    # Headers 快捷选项配置
└── icon/           # SVG 图标（主题、历史、更多菜单等）
src-tauri/
├── Cargo.toml      # Rust 依赖（tauri + reqwest + trust-dns-resolver + whois-service）
├── tauri.conf.json # Tauri 配置
├── capabilities/
│   └── default.json # 权限配置
└── src/
    ├── main.rs     # 入口
    └── lib.rs      # Rust 命令：fetch / dns_lookup / whois_lookup
```
