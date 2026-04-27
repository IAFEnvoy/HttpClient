# HTTP Client

轻量级、可视化的 API 调试工具。

*程序由DeepSeek V4 Pro编写，总Tokens：71,593,772*

## 功能

### 请求编辑
- 支持 GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS
- URL Params 可视化 Key-Value 编辑，支持批量导入 `a=1&b=2`
- Headers 编辑，快捷插入常见头（JSON / XML / Bearer 等）
- Body 四种模式：`form-data`（含文件）、`x-www-form-urlencoded`、`raw`（带实时语法高亮预览）、`binary`
- 多标签页同时编辑多个请求，标签持久化

### 认证
- No Auth / Bearer Token / Basic Auth / API Key（Header 或 Query）

### 环境变量
- 多环境切换（Dev / Prod / Local / 自定义）
- `{{变量名}}` 占位符自动替换，脚本可动态注入变量

### 请求前脚本
- 支持 JavaScript 沙箱执行，内置 `env` / `timestamp` / `random` / `url` / `method`

### cURL
- 一键生成 cURL 命令并复制
- 粘贴 cURL 命令自动填表

### 响应展示
- 状态码 + 耗时 + 大小
- 响应头表格
- JSON / XML / HTML 语法高亮 + 可折叠
- 图片 / PDF 内嵌预览
- 响应保存为本地文件、一键复制

### 历史记录
- 最近 100 条请求持久化，点击回填，支持置顶

### 主题
- 浅色 / 深色一键切换，偏好持久化

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面容器 | Tauri v2 (Rust) |
| 前端 | 原生 HTML + CSS + JS，零框架 |
| HTTP | 浏览器 `fetch` API |
| 文件操作 | Tauri `plugin-dialog` + `plugin-fs` |
| 存储 | `localStorage` |

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发模式（热重载）
pnpm tauri dev

# 构建生产包
pnpm tauri build
```

## 项目结构

```
src/
├── index.html    # UI 结构
├── styles.css    # 样式 + 深浅主题变量
└── main.js       # 全部业务逻辑（~1200 行）
src-tauri/
├── Cargo.toml    # Rust 依赖
├── tauri.conf.json # Tauri 配置
└── src/
    ├── main.rs   # 入口
    └── lib.rs    # 插件注册
```

