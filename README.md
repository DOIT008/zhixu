# Markdown Studio

一个可运行、可打包为 Windows `.exe` 的桌面 Markdown 编辑器。支持本地文件夹工作区、目录树、语雀风格顶部菜单与格式化工具栏、实时预览，以及保存后可选的 GitHub 自动提交/推送与 Actions 发布触发。

---

## 1. 项目结构

```text
markdown-studio/
├── package.json                  # 依赖、脚本、electron-builder 打包配置
├── .gitignore
├── README.md                     # 本文件
├── build/
│   └── icon.ico                  # Windows 应用图标
└── src/
    ├── main/
    │   ├── main.js               # Electron 入口：窗口生命周期
    │   ├── ipc.js                # 主进程 IPC 路由
    │   ├── workspace.js          # 工作区选择、目录树、文件读写（含路径安全校验）
    │   ├── config.js             # 配置读写；Token 优先使用 Electron safeStorage 加密
    │   ├── github.js             # GitHub 提交 + 变更扫描(SHA 对比) + 批量发布 + workflow_dispatch
    │   └── menu.js               # 原生应用菜单（与界面菜单动作一致）
    ├── preload/
    │   └── preload.js            # contextBridge 安全暴露 API
    └── renderer/
        ├── index.html            # 主界面结构
        ├── styles.css            # 毛玻璃视觉、布局、工具栏样式
        ├── markdown.js           # 轻量 Markdown → HTML 渲染（无运行时依赖）
        └── app.js                # 界面交互：菜单、工具栏、目录树、编辑器、发布
```

---

## 2. 本地运行

```bash
cd markdown-studio
npm install
npm start
```

> 需要 Node.js 18+（推荐 20/22）。首次 `npm install` 会下载 Electron 二进制，请确保网络可访问 npm registry 与 GitHub Releases。

---

## 3. 打包 Windows exe

```bash
# 生成 NSIS 安装包 + 便携版 exe
npm run build:win

# 只生成便携版 exe
npm run build:portable

# 仅展开目录，不生成安装包（调试用）
npm run pack
```

产物位于 `dist/`：

- `MarkdownStudio-1.0.0-x64.exe`：NSIS 安装程序
- `MarkdownStudio-1.0.0-portable.exe`：免安装便携版

若 GitHub Releases 下载受限，可使用国内镜像（已在本地环境验证可成功打包）：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run build:win
```

> `package.json` 中的 `repository` 字段是 electron-builder 生成更新元数据用的占位地址，可改成你自己的仓库；`publish: null` 表示不启用自动更新发布。

---

## 4. 功能说明

### 4.1 工作区与文件

- 点击左侧「选择工作区」或菜单 `文件 → 选择工作区`，选择一个本地文件夹。
- 目录树支持展开/折叠 `.md` 文件与子目录；自动忽略 `.git`、`node_modules`、`dist` 等目录。
- 新建文件默认创建在当前选中目录（或工作区根目录）下，并立即打开。
- 目录树支持右键菜单：
  - 文件夹：在此处新建文件、新建文件夹、在资源管理器中打开、重命名、删除到回收站；
  - 文件：打开、在资源管理器中显示、重命名、删除到回收站；
  - 空白处：新建文件/文件夹、在资源管理器中打开工作区、刷新目录。
  - 删除会移入系统回收站（可恢复）并需二次确认；若删除的是当前正编辑且有未保存内容的文件，会额外提示。
- `Ctrl/Cmd + S` 保存；未保存到磁盘的内容会以「未保存」状态提示。
- 全局文档搜索：点侧边栏标题的放大镜（或 `Ctrl/Cmd + Shift + F` / 编辑菜单），输入关键词实时搜索工作区内所有 Markdown 文档，按文件分组展示匹配行；点击任意结果打开文件并自动定位、高亮到对应行。
- 文档状态：编辑器标题旁的徽章实时显示「已保存 / 未保存 / 就绪」，已保存时附带保存时间；目录树中当前未保存文件会带橙点标记；底部状态栏补充字数与行数统计。
- PDF 导出：点编辑器标题栏的「PDF」按钮（或 `Ctrl/Cmd + Shift + E` / 文件菜单），将预览渲染结果导出为 A4 PDF，含页码、中文字体与代码样式。
- 所有读写都经过工作区边界校验，阻止 `../` 越权访问。

### 4.2 顶部菜单与工具栏

- 自定义顶部菜单：`文件 / 编辑 / 视图 / 语法 / 发布`，以及常用快捷入口。
- 原生菜单栏同时保留相同动作，支持系统级快捷键。
- 「语法」菜单分 Markdown 常用 / VitePress 扩展两组，点选即在光标处一键插入对应语法片段；VitePress 项带 `VP` 标签，菜单底部可直接打开语法演练场。
- 格式化工具栏参考截图实现：新建、撤销/重做、复制、正文/标题样式、字号、粗体、斜体、删除线、下划线、文字颜色、高亮、对齐、无序/有序/任务列表、链接、引用、分割线、图片、行内代码、代码块。
- 撤销/重做采用应用内历史栈（`Ctrl+Z` 撤销、`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做），不依赖浏览器原生 undo，格式化操作也能正确回退；切换文件会重置历史。复制按钮在系统剪贴板 API 不可用时自动回退到兼容方案。
- 缩进：对齐按钮旁的缩进下拉（或 `Ctrl+]` 增加缩进 / `Ctrl+[` 减少缩进）对选中行的每行加/减两个空格，支持列表嵌套。
- 格式刷：先选中带格式的文本（标题/列表/引用/粗斜体/删除线/下划线/颜色/高亮/渐变/对齐/链接均可），点工具栏格式刷按钮（按钮高亮进入刷子模式），再选中目标文本即自动套用相同格式；按 `Esc` 或再次点按钮取消。
- 清除格式：工具栏清除格式按钮（或编辑菜单）去掉所选行的全部 Markdown / 扩展标记，仅保留纯文本。
- 新建文件、查找、覆盖确认均使用应用内弹窗（不依赖 `prompt/confirm`），输入文件名后点「创建并打开」即可在工作区新建 Markdown。
- 文字颜色、背景高亮：点击对应按钮弹出调色板，内置常用色板 + 自定义取色器，均有默认值（文字 `#e11d48`、高亮 `#fde047`）。**写入的是通用内联 HTML**：文字色 `<span style="color:#hex">文字</span>`、高亮 `<mark style="background-color:#hex">文字</mark>`、渐变 `<span style="background-image:linear-gradient(...)">文字</span>`。这样源文件用任何 Markdown 软件打开都能显示样式。
- 下划线、默认高亮：分别写入 `<u>文字</u>` 与 `<mark>文字</mark>`，同为通用内联 HTML。
- 对齐方式：语雀式横向浮层，提供左/中/右/两端四选项，选中态高亮；写入 `<div style="text-align:center">文字</div>`（left/center/right/justify）。
- 行高：工具栏行高下拉（默认 / 1 / 1.15 / 1.5 / 2 / 2.5 / 3）作用于编辑器与预览，视图菜单也可增减，设置会持久化。
- 任务列表：预览中的复选框可直接点击勾选，自动回写源文件的 `- [ ]` / `- [x]`；编辑器在有序/无序/任务列表行按 `Enter` 自动续上列表标记，空列表项按 `Enter` 退出列表。
- 段落样式与字号使用自定义毛玻璃下拉框，选项更丰富；表格按钮提供行列网格选择器，悬停即可选择 `列 × 行`。下拉浮层采用高不透明度实底 + 背景模糊，避免文字与后方内容重叠。
- 目录树使用重新设计的双色文件夹与文档图标，现代且辨识度高。
- 「视图 → 语法演练场…」或工具栏「语法」按钮打开演练场：分 Markdown 基础 / VitePress 扩展两页，左侧示例、右侧实时渲染，可一键插入示例。
- 视图模式：分屏 / 仅编辑 / 仅预览；支持字号增减与日志面板开关。
- 侧边栏可折叠：点目录标题右侧的折叠按钮（或 `Ctrl+B` / 视图菜单）收起，左缘留下窄条，点它即可展开。
- 分屏状态下，编辑器与预览之间有一条可拖拽分隔条，左右拖动自由调整两栏宽度；折叠状态、分栏比例均会保存到配置，下次启动自动恢复。
- **多标签页**：编辑器标题栏的标签栏可同时打开多个文档，点击标签切换、点 `×` 或中键关闭（`Ctrl+W` 关闭当前标签、`Ctrl+Tab` / `Ctrl+Shift+Tab` 切换）。每个标签独立保存未编辑状态、光标/滚动位置与撤销历史，切换不丢改动；关闭有改动的标签会提示保存。重命名/删除文件会同步更新或关闭对应标签。
- **查找与替换**：`Ctrl+F` 打开「查找与替换」弹窗（`Ctrl+H` 直接聚焦替换框），支持「区分大小写 / 正则表达式 / 全字匹配」，可查找上一个/下一个（回车 / `Shift+回车`）、单个替换、全部替换（正则替换支持 `$1`、`$&` 反向引用）。
- **大纲导航**：侧边栏顶部可在「目录 / 大纲」间切换。大纲列出当前文档所有标题（跳过 frontmatter 与代码块），按层级缩进，点击即跳转编辑器对应行并滚动预览到该标题，当前项高亮。支持标题末尾的自定义锚点 `{#id}`。
- **自动保存与版本历史**：设置中开启「自动保存」后可设定间隔（默认 30 秒），仅对有改动的文件生效，且不会触发 GitHub 发布。每次保存（手动/自动/另存为）都会在用户数据目录生成带时间戳的本地快照，点编辑器标题栏「历史」可查看并恢复到任意版本（最多保留 40 个）。
- **暗色/亮色主题**：工具栏月亮/太阳按钮一键切换（`设置 → 编辑偏好` 中持久化），覆盖标题栏、面板、编辑器、预览、弹窗与代码高亮的配色。

### 4.3 VitePress 兼容预览

预览渲染器内置常用 VitePress 语法，尽量让本地预览与发布后一致：

- 顶部 YAML Frontmatter（`--- ... ---`）按 VitePress 行为隐藏，不作为正文显示。
- 自定义容器：`::: tip`、`::: info`、`::: warning`、`::: danger`、`::: details`，支持自定义标题，例如 `::: warning 请注意`。
- 代码组：`::: code-group` + 多个带标题的代码块，生成可切换标签页。
- 代码块标题与行高亮：```` ```js{1,3-4} title="demo.js" ```` 或 ```` ```js [demo.js] ````。
- 代码语法高亮：内置离线高亮器，支持 JS/TS、Python、HTML/Vue、CSS、JSON、Bash、SQL、Go、Rust、Java、YAML 等常见语言的关键字、字符串、注释、数字、函数名着色。
- 代码字体：内置 JetBrains Maple Mono（TTF 随应用打包，离线可用），行内代码、代码块、编辑器与行号统一使用该字体。
- 目录占位符 `[[toc]]`：按文档标题生成可点击目录。
- 标题自动生成 id，支持锚点跳转；标题末尾加 `{#custom-id}` 可指定自定义锚点（如 `## 安装 {#install}`）。
- GitHub 风格 Alert：`> [!NOTE]`、`> [!TIP]`、`> [!IMPORTANT]`、`> [!WARNING]`、`> [!CAUTION]` 渲染为对应提示框，与 VitePress/GitHub 一致。
- Emoji 缩写：`:smile:` → 😄、`:tada:` → 🎉、`:rocket:` → 🚀 等常用缩写；未识别的缩写原样保留。
- `::: raw` 容器：内部内容原样输出、不解析 Markdown（用于展示需要保持字面的内容）。

> 仍需在目标 VitePress 主题中保留相同配置；本编辑器覆盖的是常见 Markdown It / VitePress 语法子集，不执行 Vue 组件编译。以上新增语法均已在「语法演练场 → VitePress 扩展」中提供示例。

### 4.3.1 发布到 VitePress / GitHub Pages 的样式兼容性

> **当前方案（内联 HTML）**：文字颜色、背景高亮、渐变、下划线、对齐等样式，编辑器现在**直接写入通用内联 HTML**，不再使用自研的 `{color:...}` 类语法。好处是源文件在 VitePress、GitHub、VS Code、Typora 等几乎任何 Markdown 软件中打开都能正确显示样式，无需任何转换。代价是源码中会出现 HTML 标签，可读性略差（编辑器已对标签做语法着色，正文仍保持清爽）。

新文档写入的内容与发布结果完全一致（**原样提交，无需转换**）：

| Toolbar 操作 | 写入源文件（= 发布内容） | 各软件表现 |
| --- | --- | --- |
| 文字颜色 | `<span style="color:#hex">文字</span>` | VitePress / VS Code / Typora 正常；GitHub 保留文字但会过滤 `style` 颜色 |
| 背景高亮 | `<mark style="background-color:#hex">文字</mark>` | VitePress / VS Code / Typora 正常；GitHub 显示为 `<mark>` 默认黄底 |
| 渐变文字 | `<span style="background-image:linear-gradient(...)">文字</span>` | VitePress / 本地软件正常；GitHub 会过滤 `style` |
| 下划线 | `<u>文字</u>` | 通用支持 |
| 对齐 | `<div style="text-align:center">文字</div>` | VitePress / 本地软件正常；GitHub 会过滤 `style` |
| 标题 / 列表 / 任务列表 / 引用 / 链接 / 图片 / 粗斜体 / 删除线 / 表格 / 分割线 | 标准 Markdown | 全平台通用 |

**关于 GitHub 的 `style` 过滤**：GitHub 出于安全会剥离内联 `style` 属性。因此发布到 GitHub Pages 时，结构标签（`<span>`/`<mark>`/`<u>`）会保留，但颜色/渐变/对齐等需靠 `style` 生效的样式会退化为默认外观。这是 GitHub 的固有行为，与编辑器无关；VitePress 自建站不受此限制，可完整显示。

> 提示：VitePress 基于 markdown-it，默认允许内联 HTML。若站点显式关闭了 HTML（`html: false`），上述标签会被转义显示，需要恢复该选项。

**旧文档兼容**：早期版本用自研语法（`{color:#hex\|文字}`、`{bg:...}`、`{grad:...}`、`{align:...}`、`==文字==`、`++下划线++`）保存的文件仍可正常预览与编辑。点「发布」时，主进程会自动把这些旧语法转换为内联 HTML（跳过代码块与 frontmatter），确保旧文档发布到 VitePress 也不丢样式。可在 `发布 → GitHub 发布设置` 中取消勾选「发布时转换旧版扩展语法」关闭该行为。新文档本来就写内联 HTML，不受此选项影响。

### 4.4 预览变更并选择性发布

点工具栏「发布」按钮（或 `发布 → 预览变更并发布`，快捷键 `Ctrl+Shift+P`）会**先弹出变更预览**，而不是直接提交：

- 应用会用 Git blob SHA-1 精确对比本地工作区与远程仓库（`GET /git/trees/{branch}?recursive=1` 一次拉取整棵文件树），列出所有有差异的文件，分为**修改 / 新增 / 删除**三类；内容完全相同（含发布时的语法转换结果）的文件不会列出。
- 每个文件可点「改动 ▾」展开逐行 diff（新增/删除标色，折叠未变更区域），先看清「都改了啥」。
- 默认全选，可按需取消勾选**只发布其中一部分**；顶部「全选」可一键切换，弹窗实时显示已选数量。
- 确认后用 Git Data API（创建 blob → tree → commit → 更新 ref）把**所有选中文件放进一次提交**，`workflow_dispatch` 只触发一次；删除项以 `sha: null` 从仓库移除。
- 扫描/对比过程写入「发布日志」，失败会在状态栏与日志中显示原因。

> 说明：对比基准是**线上 GitHub 仓库的当前内容**，与是否开启「保存后自动发布」无关。只想静默发布当前单个文件时，仍可用保存后自动发布（见 4.5）。

### 4.5 GitHub 自动发布

在 `发布 → GitHub 发布设置` 中填写：

| 字段 | 说明 |
| --- | --- |
| 启用自动发布 | 保存后是否自动提交并触发 Actions |
| 发布时转换旧版扩展语法 | 默认开启，仅把老文档的 `{color:}` 等旧语法转为内联 HTML；新文档已直接写入内联 HTML，不受影响 |
| Repository Owner | GitHub 用户名或组织名 |
| Repository Name | 仓库名 |
| Branch | 目标分支，如 `main` |
| Access Token | Personal Access Token，需 `repo` 权限；若启用 Actions 还需 `workflow` 范围 |
| 仓库内目标目录 | 例如 `docs`，留空表示仓库根目录 |
| 提交信息模板 | 支持 `{file}` 占位符 |
| Workflow 文件 | 例如 `deploy.yml`，触发 `workflow_dispatch` |
| Workflow Ref | dispatch 使用的分支/Tag，默认同 Branch |

Token 在 Windows 上优先使用 Electron `safeStorage`（DPAPI）加密后写入用户数据目录；若系统不支持加密，会降级为明文存储并在日志中给出警告。**请不要将包含 Token 的配置同步到公共仓库。**

「保存后自动发布」（单文件静默提交）的流程：

1. 保存本地 Markdown 文件；
2. 若开启「发布时转换旧版扩展语法」且文档中含老式自研语法，先转换为内联 HTML（跳过代码块与 frontmatter），并在日志中记录；新文档已是内联 HTML，直接进入下一步；
3. 调用 GitHub Contents API：先 `GET` 获取原文件 SHA（不存在则新建），再 `PUT` 提交 Base64 内容；
4. 调用 `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` 触发发布；
5. 任意步骤失败都会在右下角状态提示与「发布日志」中显示 HTTP 状态码与错误消息。

手动点「发布」则走 4.4 的预览式批量流程，不会触发上述单文件自动发布。两种方式的语法转换规则一致。

---

## 5. 环境限制与手动替代方案

以下情况在本环境中可能无法完整验证，但源码已按可落地方式实现：

| 场景 | 影响 | 替代方案 |
| --- | --- | --- |
| 无网络 / npm 镜像不可达 | 无法 `npm install`，也就无法打包 | 在有网络的机器执行 `npm install` 后复制 `node_modules`，或配置私有 npm 镜像 |
| 无法下载 Electron 二进制 | `npm start` 失败 | 设置 `ELECTRON_MIRROR` 后重装；或直接使用已安装 Electron |
| 无 GitHub Token / 仓库权限 | 自动发布会返回 401/403 | 手动 `git add/commit/push`，或在 GitHub 网页端上传文件后手动 Run workflow |
| 企业代理 / 自托管 GitHub | API 地址不同 | 当前实现面向 `api.github.com`；如需 GHES，需替换 `github.js` 中的 API 常量 |
| Windows 签名证书缺失 | exe 会触发 SmartScreen 提示 | 使用代码签名证书签名，或分发时说明来源 |

---

## 6. 许可证

MIT
