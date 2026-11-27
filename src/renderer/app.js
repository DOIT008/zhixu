'use strict';

(function () {
  const api = window.mdStudio;
  const $ = (id) => document.getElementById(id);

  if (!api) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#b91c1c">预加载脚本未加载，请在 Electron 环境中运行，而不是直接用浏览器打开 HTML。</div>';
    return;
  }

  const PERF = !!api.perfEnabled;
  const RENDER_START = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  function perf(label) {
    if (PERF) console.log(`[perf:renderer] ${label} @${Date.now()} +${Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - RENDER_START)}ms`);
  }
  perf('script start');

  // 启动阶段的“最近打开/会话”写盘不阻塞首屏：浏览器空闲时再写，退出时仍会立即保存。
  function runWhenIdle(fn) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => fn(), { timeout: 1200 });
    } else {
      setTimeout(fn, 0);
    }
  }

  const editor = $('editor');
  const gutter = $('gutter');
  const preview = $('preview');
  const tree = $('tree');
  const highlightLayer = $('editorHighlight');
  const highlightCode = $('highlightCode');
  const expandedDirs = new Set();

  const state = {
    config: null,
    workspace: '',
    tree: [],
    currentFile: '',
    dirty: false,
    fontSize: 16,
    lineHeight: 1.7,
    theme: 'light',
    mood: 'auto',
    syntaxHighlight: true,
    viewMode: 'split',
    focusMode: false,
    sidebarCollapsed: false,
    editorFr: 1,
    previewFr: 1,
    logOpen: false,
    lastSavedAt: null,
    formatPainter: null,
    tabs: [],
    activeTabId: '',
    tabCounter: 0,
    publish: { level: '', text: '发布就绪' },
    imagePreviewPath: '',
    // 未发布更改标识：相对工作区的路径 → 状态(modified/added/deleted)；用于目录树 git 风格徽标
    publishMarks: new Map(),
    publishMarksActive: false
  };

  let previewTimer = null;
  let scrollOutlineTimer = null;
  let toastTimer = null;
  let autoSaveTimer = null;
  let lastAutoSaveAt = 0;
  let publishMarksTimer = null;
  let publishingMarksScan = false;
  let playgroundTab = 'markdown';
  let playgroundSelected = 0;
  let contextTarget = null;
  let newFileDir = ''; // 新建文件对话框里用户选择的保存位置
  let draftTimer = null; // 草稿备份节流计时器
  let draftRestoreChecked = false;
  let commandItems = [];
  let commandIndex = 0;
  let lastSearchHits = [];
  let pendingTemplate = null; // 从模板新建时，待写入新文件内容

  // 自研撤销/重做历史栈：textarea 上 document.execCommand('undo'/'redo') 不可靠
  const history = { stack: [''], index: 0 };
  let historyLocked = false;

  // ---------- 多标签页 ----------
  function createTab(path, content) {
    state.tabCounter += 1;
    const tab = {
      id: `tab-${state.tabCounter}`,
      path: path || '',
      name: path ? basename(path) : '未命名文档',
      content: String(content || ''),
      dirty: false,
      lastSavedAt: null,
      scrollTop: 0,
      history: { stack: [String(content || '')], index: 0 }
    };
    state.tabs.push(tab);
    return tab;
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
  }

  // ---------- 会话恢复：记住并还原上次打开的文档 ----------
  let sessionSaveTimer = null;

  function captureSession() {
    const files = [];
    state.tabs.forEach((tab) => {
      if (tab.path) files.push(tab.path);
    });
    const active = activeTab();
    return { files, activePath: active && active.path ? active.path : '' };
  }

  // 延迟写入，合并连续的标签操作；immediate 用于退出等关键节点
  function persistSession(immediate) {
    if (!state.config) return;
    const write = () => {
      sessionSaveTimer = null;
      const cfg = { ...state.config, session: captureSession() };
      state.config = cfg;
      api.saveConfig(cfg).catch(() => {});
    };
    if (immediate) {
      if (sessionSaveTimer) { clearTimeout(sessionSaveTimer); sessionSaveTimer = null; }
      write();
    } else {
      if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
      sessionSaveTimer = setTimeout(write, 300);
    }
  }

  // 启动时重新打开上次的文档标签，并定位到上次激活的文件。
  // 批量恢复：并行读取文件、只刷新一次界面、只写一次配置，避免启动阶段反复保存 config.json。
  async function restoreSession() {
    const session = state.config && state.config.session;
    const files = session && Array.isArray(session.files) ? session.files : [];
    if (!files.length) return 0;

    const restored = await Promise.all(files.map(async (filePath) => {
      if (!filePath) return null;
      try {
        await api.grantPath(filePath);
        const result = await api.readFile(filePath);
        return createTab(result.path, result.content);
      } catch (err) {
        log(`恢复文档失败：${basename(filePath)}（${err.message}）`, 'error');
        return null;
      }
    }));

    const tabs = restored.filter(Boolean);
    if (!tabs.length) return 0;
    state.tabs = tabs;
    const target = session.activePath && tabs.find((tab) => tab.path === session.activePath);
    state.activeTabId = (target || tabs[0]).id;
    state.currentFile = (target || tabs[0]).path;
    bindHistory(target || tabs[0]);

    // 与逐个 openFile 相同的“最近打开”顺序：后恢复的文件排在最前。
    const recent = getRecentFiles();
    files.forEach((filePath) => {
      const idx = recent.indexOf(filePath);
      if (idx >= 0) recent.splice(idx, 1);
      recent.unshift(filePath);
    });
    const nextRecent = recent.slice(0, RECENT_LIMIT);
    runWhenIdle(() => persistRecent({ files: nextRecent }));
    runWhenIdle(() => persistSession(false));
    log(`已恢复上次打开的 ${tabs.length} 个文档`, 'success');
    return tabs.length;
  }

  // 把编辑器当前内容/状态与历史栈同步回活动标签
  function syncActiveTab() {
    const tab = activeTab();
    if (!tab) return;
    tab.content = editor.value;
    tab.dirty = state.dirty;
    tab.lastSavedAt = state.lastSavedAt;
    tab.scrollTop = editor.scrollTop;
    tab.history.stack = history.stack.slice();
    tab.history.index = history.index;
  }

  // 把全局 history 指向某个标签自己的历史栈
  function bindHistory(tab) {
    history.stack = tab.history.stack.slice();
    history.index = Math.min(tab.history.index, history.stack.length - 1);
  }

  function renderTabs() {
    const bar = $('tabbar');
    if (!bar) return;
    bar.innerHTML = state.tabs.map((tab) => {
      const active = tab.id === state.activeTabId;
      const dirtyDot = tab.dirty ? '<span class="tab-dirty" title="未保存"></span>' : '';
      return `<div class="tab${active ? ' active' : ''}" data-id="${tab.id}" title="${escapeHtml(tab.path || tab.name)}">`
        + `<svg class="icon" style="width:13px;height:13px"><use href="#i-file-modern"></use></svg>`
        + `<span class="tab-name">${escapeHtml(tab.name)}</span>${dirtyDot}`
        + `<button class="tab-close" data-close="${tab.id}" title="关闭标签">×</button></div>`;
    }).join('');
    // 横向滚动到活动标签
    const activeEl = bar.querySelector('.tab.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // 切换标签：先把当前编辑器状态存回旧标签，再载入目标标签
  function activateTab(tabId) {
    if (tabId === state.activeTabId) return;
    const target = state.tabs.find((tab) => tab.id === tabId);
    if (!target) return;
    syncActiveTab();
    state.activeTabId = tabId;
    state.currentFile = target.path;
    state.dirty = target.dirty;
    state.lastSavedAt = target.lastSavedAt;
    bindHistory(target);
    historyLocked = true;
    editor.value = target.content;
    editor.setSelectionRange(0, 0);
    historyLocked = false;
    updateStatus();
    updateGutter();
    updateHighlight();
    schedulePreview();
    renderTabs();
    requestAnimationFrame(() => {
      editor.scrollTop = target.scrollTop || 0;
      gutter.scrollTop = editor.scrollTop;
      highlightLayer.scrollTop = editor.scrollTop;
    });
    persistSession();
  }

  async function closeTab(tabId) {
    const index = state.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const tab = state.tabs[index];
    if (tab.dirty) {
      const ok = await askConfirm('文件未保存', `「${tab.name}」有未保存的更改，是否先保存？\n点“取消”可返回继续编辑。`);
      if (ok) {
        if (tab.id === state.activeTabId) {
          const saved = await saveFile({ skipAuto: true });
          if (!saved) return;
        } else {
          // 非活动标签：暂存内容后写盘
          try {
            await api.writeFile(tab.path || state.workspace, tab.content);
            tab.dirty = false;
          } catch (err) {
            toast(`保存失败：${err.message}`, 'error');
            return;
          }
        }
      } else {
        // 用户在确认框点了“取消”：返回继续编辑，不关闭标签
        return;
      }
    }
    syncActiveTab();
    state.tabs.splice(index, 1);
    if (state.activeTabId === tabId) {
      const next = state.tabs[index] || state.tabs[index - 1] || null;
      if (next) {
        state.activeTabId = '';
        activateTab(next.id);
      } else {
        state.activeTabId = '';
        state.currentFile = '';
        state.dirty = false;
        state.lastSavedAt = null;
        historyLocked = true;
        editor.value = '';
        history.stack = [''];
        history.index = 0;
        historyLocked = false;
        updateStatus();
        updateGutter();
        updateHighlight();
        schedulePreview();
      }
    }
    renderTabs();
    refreshTree();
    persistSession();
  }


  const PLAYGROUND = {
    markdown: [
      { title: '标题', desc: '用 # 到 ###### 生成一级到六级标题', syntax: '# 一级标题\n## 二级标题\n### 三级标题' },
      { title: '文字样式', desc: '粗体、斜体、删除线、下划线用 Markdown；颜色/高亮/对齐/渐变用通用内联 HTML，任何 Markdown 软件都能显示', syntax: '**粗体** *斜体* ~~删除线~~ <u>下划线</u>\n\n<mark>默认高亮</mark> <mark style="background-color:#86efac">自定义高亮</mark> <span style="color:#e11d48">彩色文字</span>\n\n<span style="background-image:linear-gradient(135deg,#1890FF,#722ED1);color:transparent;-webkit-background-clip:text;background-clip:text;font-weight:600">渐变文字</span>\n\n<div style="text-align:center">居中文字</div>' },
      { title: '列表', desc: '无序列表、有序列表和可勾选的任务列表', syntax: '- 无序项 A\n- 无序项 B\n\n1. 有序项 A\n2. 有序项 B\n\n- [x] 已完成\n- [ ] 未完成' },
      { title: '引用', desc: '以 > 开头的多行引用块', syntax: '> 这是一段引用内容。\n> 可以跨多行显示。' },
      { title: '链接与图片', desc: '行内链接和图片语法', syntax: '[WorkBuddy 文档](https://www.workbuddy.cn/docs/)\n\n![示例图片](https://via.placeholder.com/320x120?text=Markdown)' },
      { title: '行内代码与代码块', desc: '反引号包裹行内代码，三个反引号包裹代码块', syntax: '行内代码：`const a = 1`\n\n```js\nconst greeting = "Hello Markdown";\nconsole.log(greeting);\n```' },
      { title: '分割线', desc: '三个及以上连字符生成水平分割线', syntax: '分割线上方内容\n\n---\n\n分割线下方内容' },
      { title: '表格', desc: 'GFM 风格表格，支持左/中/右对齐', syntax: '| 功能 | 语法 | 对齐 |\n| :--- | :---: | ---: |\n| 标题 | `#` | 左 |\n| 粗体 | `**文字**` | 中 |\n| 链接 | `[文字](url)` | 右 |' }
    ],
    vitepress: [
      { title: 'YAML Frontmatter', desc: '页面元数据，预览中按 VitePress 行为隐藏', syntax: '---\ntitle: 我的文档\ndescription: 使用 VitePress 发布\n---\n\n# 正文从这里开始' },
      { title: '目录 [[toc]]', desc: '根据文档标题自动生成可点击目录', syntax: '[[toc]]\n\n## 第一章\n\n### 1.1 小节\n\n## 第二章' },
      { title: '提示容器 tip', desc: '绿色提示框，可自定义标题', syntax: '::: tip 小提示\n这是一条提示信息。\n:::' },
      { title: '信息容器 info', desc: '蓝色信息框', syntax: '::: info 说明\n这里是需要留意的信息。\n:::' },
      { title: '警告与危险容器', desc: 'warning 黄色警告，danger 红色警告', syntax: '::: warning 注意\n这是一条警告信息。\n:::\n\n::: danger 危险\n这是一条危险提示。\n:::' },
      { title: '折叠面板 details', desc: '点击标题展开或收起内容', syntax: '::: details 点击展开详情\n这里是可以折叠的内容。\n:::' },
      { title: '代码组 code-group', desc: '多个代码块显示为可切换标签页', syntax: '::: code-group\n\n```js [a.js]\nconst a = 1\n```\n\n```ts [b.ts]\nconst b: number = 2\n```\n\n:::' },
      { title: '代码块标题与行高亮', desc: '支持 {行号} 高亮和 title="文件名"', syntax: '```js{1,3-4} title="demo.js"\nconst a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n```' },
      { title: 'GitHub Alert 提示框', desc: '> [!NOTE] / [!TIP] / [!WARNING] 等，与 VitePress 一致', syntax: '> [!NOTE]\n> 这是一条说明信息。\n\n> [!WARNING]\n> 这是一条警告信息。' },
      { title: 'Emoji 缩写', desc: ':smile: 会渲染为 😄，VitePress 默认支持', syntax: '发布成功 :tada: 记得保存 :memo: 有问题看文档 :book:' },
      { title: '自定义锚点 {#id}', desc: '在标题末尾加 {#id} 指定锚点，方便目录精确定位', syntax: '## 安装步骤 {#install}\n\n用 `#install` 就能直接跳到这里。' },
      { title: 'raw 原样容器', desc: '::: raw 内的内容原样输出，不解析 Markdown', syntax: '::: raw\n**这段内容不会被解析**，会原样输出。\n:::' }
    ]
  };

  // 顶部菜单「语法」一键插入片段（与演练场共用同一套语法，保证预览一致）
  const SNIPPETS = {
    heading: { label: '标题', syntax: '# 一级标题\n## 二级标题\n### 三级标题' },
    list: { label: '列表', syntax: '- 无序项 A\n- 无序项 B\n\n1. 有序项 A\n2. 有序项 B\n\n- [x] 已完成\n- [ ] 未完成' },
    quote: { label: '引用', syntax: '> 这是一段引用内容。\n> 可以跨多行显示。' },
    link: { label: '链接', syntax: '[链接文字](https://example.com)' },
    image: { label: '图片', syntax: '![图片描述](https://example.com/image.png)' },
    codeblock: { label: '代码块', syntax: '```js\nconst a = 1\n```' },
    table: { label: '表格', syntax: '| 功能 | 语法 | 对齐 |\n| :--- | :---: | ---: |\n| 标题 | `#` | 左 |\n| 粗体 | `**文字**` | 中 |\n| 链接 | `[文字](url)` | 右 |' },
    hr: { label: '分割线', syntax: '---' },
    frontmatter: { label: 'YAML Frontmatter', syntax: '---\ntitle: 我的文档\ndescription: 使用 VitePress 发布\n---' },
    toc: { label: '目录 [[toc]]', syntax: '[[toc]]' },
    tip: { label: '提示容器 tip', syntax: '::: tip 小提示\n这是一条提示信息。\n:::' },
    info: { label: '信息容器 info', syntax: '::: info 说明\n这里是需要留意的信息。\n:::' },
    warning: { label: '警告容器 warning', syntax: '::: warning 注意\n这是一条警告信息。\n:::' },
    danger: { label: '危险容器 danger', syntax: '::: danger 危险\n这是一条危险提示。\n:::' },
    details: { label: '折叠面板 details', syntax: '::: details 点击展开详情\n这里是可以折叠的内容。\n:::' },
    codeGroup: { label: '代码组 code-group', syntax: '::: code-group\n\n```js [a.js]\nconst a = 1\n```\n\n```ts [b.ts]\nconst b: number = 2\n```\n\n:::' },
    codeHighlight: { label: '代码块高亮', syntax: '```js{1,3-4} title="demo.js"\nconst a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n```' },
    alert: { label: 'GitHub Alert 提示框', syntax: '> [!NOTE]\n> 这是一条说明信息。' },
    raw: { label: 'raw 原样容器', syntax: '::: raw\n**原样输出，不解析 Markdown**\n:::' }
  };

  function insertSnippet(key) {
    if (key === 'frontmatter') return openFrontmatterDialog();
    const item = SNIPPETS[key];
    if (!item) return;
    insertBlock(item.syntax);
    toast(`已插入「${item.label}」`, 'success');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Electron invoke 抛错会带 "Error invoking remote method 'x': Error: " 前缀，剥掉后提示更干净
  function cleanError(err) {
    return String((err && err.message) || err || '未知错误')
      .replace(/^Error invoking remote method '[^']+':\s*/, '')
      .replace(/^Error:\s*/, '');
  }

  // 源码语法着色：只给 Markdown / VitePress 标记加 class，正文保持主色，降低阅读干扰
  function highlightMarkdownSource(source) {
    const lines = String(source || '').split('\n');
    let fmEnd = -1;
    if (/^\s*---\s*$/.test(lines[0] || '')) {
      for (let i = 1; i < Math.min(lines.length, 60); i += 1) {
        if (/^\s*(---|\.\.\.)\s*$/.test(lines[i])) { fmEnd = i; break; }
      }
    }
    let fence = '';
    let codeHighlighter = null;
    const out = [];

    lines.forEach((line, index) => {
      const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);

      if (fmEnd >= 0 && index <= fmEnd) {
        out.push(`<span class="md-fm">${escapeHtml(line)}</span>`);
        return;
      }
      if (fence) {
        const closes = fenceMatch && fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length;
        if (closes) {
          out.push(`<span class="md-fence">${escapeHtml(line)}</span>`);
          fence = '';
          codeHighlighter = null;
        } else if (codeHighlighter && window.MarkdownRender && window.MarkdownRender.createHighlighter) {
          // 代码块内部：用预览同款语言高亮器逐行着色（保留跨行块注释状态）
          out.push(`<span class="md-code-hl">${codeHighlighter.line(line)}</span>`);
        } else {
          out.push(`<span class="md-code">${escapeHtml(line)}</span>`);
        }
        return;
      }
      if (fenceMatch) {
        out.push(`<span class="md-fence">${escapeHtml(line)}</span>`);
        fence = fenceMatch[2];
        // 解析代码语言，创建对应高亮器（未知语言回退到通用 c/js 风格）
        if (window.MarkdownRender && window.MarkdownRender.createHighlighter && window.MarkdownRender.parseCodeInfo) {
          const info = window.MarkdownRender.parseCodeInfo(fenceMatch[3] || '');
          codeHighlighter = window.MarkdownRender.createHighlighter(info.lang);
        } else {
          codeHighlighter = null;
        }
        return;
      }
      if (/^\s*:{3,}/.test(line)) {
        const m = line.match(/^(\s*)(:{3,}[^\n]*)$/);
        out.push(`${m[1]}<span class="md-container">${escapeHtml(m[2])}</span>`);
        return;
      }
      if (line.includes('|') && /^\s*\|?[\s:\-|]+\|?\s*$/.test(line)) {
        out.push(`<span class="md-table-sep">${escapeHtml(line)}</span>`);
        return;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push(`<span class="md-hr">${escapeHtml(line)}</span>`);
        return;
      }

      let html = escapeHtml(line);
      html = html.replace(/^(\s*)(#{1,6})(\s+)/, '$1<span class="md-heading">$2</span>$3');
      html = html.replace(/^(\s*)(&gt;+)(\s?)/, '$1<span class="md-quote">$2</span>$3');
      html = html.replace(/^(\s*)([-+*]|\d+\.)(\s+)/, '$1<span class="md-list">$2</span>$3');
      html = html.replace(/\[([ xX])\](?=\s)/g, '<span class="md-task">[$1]</span>');
      html = html.replace(/(`+)([^`\n]+?)\1/g, '<span class="md-code-inline">$1$2$1</span>');
      // 方案2：内联 HTML 标签作为语法着色（标签本身弱化为语法色，标签之间的正文保持主色）
      html = html.replace(/(&lt;\/?(?:span|mark|u|div|br|strong|em|b|i|sub|sup|small)\b.*?&gt;)/gi, '<span class="md-ext">$1</span>');
      // 兼容旧版自研扩展语法着色
      html = html.replace(/(\{color:#[0-9a-fA-F]{3,8}\|[^}\n]+\}|\{bg:#[0-9a-fA-F]{3,8}\|[^}\n]+\}|\{grad:[^}\n]+\}|\{align:(?:left|center|right|justify)\|[^}\n]+\}|==#[0-9a-fA-F]{3,8}\|[^=\n]+==|\[\[toc\]\])/g, '<span class="md-ext">$1</span>');
      html = html.replace(/(\[([^\]\n]*)\]\()([^)\n]+)(\))/g, '<span class="md-link">$1</span><span class="md-url">$3</span><span class="md-link">$4</span>');
      html = html.replace(/(\*\*|__)([^*\n]+?)\1/g, '<span class="md-emph">$1</span>$2<span class="md-emph">$1</span>');
      html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<span class="md-emph">*</span>$1<span class="md-emph">*</span>');
      html = html.replace(/(~~)([^~\n]+?)\1/g, '<span class="md-del">$1</span>$2<span class="md-del">$1</span>');
      html = html.replace(/(\+\+)([^+\n]+?)\1/g, '<span class="md-emph">$1</span>$2<span class="md-emph">$1</span>');
      html = html.replace(/(==)([^=\n]+?)\1/g, '<span class="md-ext">$1</span>$2<span class="md-ext">$1</span>');
      html = html.replace(/\|/g, '<span class="md-pipe">|</span>');
      out.push(html);
    });

    return out.join('\n');
  }

  function updateHighlight() {
    if (!highlightCode || !highlightLayer) return;
    highlightCode.innerHTML = highlightMarkdownSource(editor.value);
    highlightLayer.scrollTop = editor.scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;
  }

  function basename(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || '';
  }

  // 预览资源解析：Markdown 里的相对图片路径按「当前文档所在目录」解析，
  // 而不是按应用安装目录。渲染层的 file:// 图片可以直接显示。
  function resolveResourceUrl(raw) {
    const url = String(raw || '').trim();
    if (!url || /^(https?:|data:|blob:|mailto:|file:|#|\?)/i.test(url)) return url;
    const tab = activeTab();
    const baseFile = (tab && tab.path) || (state.workspace ? state.workspace + '\\__mojian_doc__.md' : '');
    if (!baseFile) return url;
    const clean = url.replace(/^<|>$/g, '');
    const match = clean.match(/^([^?#]*)([?#].*)?$/);
    let rel = match[1] || '';
    const suffix = match[2] || '';
    try { rel = decodeURIComponent(rel); } catch (_err) { /* 保留原始编码 */ }
    // Windows 绝对路径直接转 file URL
    if (/^[a-zA-Z]:[\\/]/.test(rel)) {
      return encodeURI('file:///' + rel.replace(/\\/g, '/')) + suffix;
    }
    // 以 / 开头按工作区根目录解析，否则按当前文件目录解析
    const fromRoot = /^[\\/]/.test(rel);
    rel = rel.replace(/^[\\/]+/, '');
    const baseDir = fromRoot && state.workspace ? state.workspace : dirnameOf(baseFile);
    if (!baseDir) return url;
    const parts = (baseDir.replace(/\\/g, '/') + '/' + rel.replace(/\\/g, '/')).split('/');
    const stack = [];
    parts.forEach((part) => {
      if (!part || part === '.') return;
      if (part === '..') { stack.pop(); return; }
      stack.push(part);
    });
    let full = stack.join('/');
    if (!/^[a-zA-Z]:/.test(full)) full = '/' + full;
    return encodeURI('file:///' + full.replace(/^\//, '')) + suffix;
  }

  function log(message, level = 'info') {
    const list = $('logList');
    const line = document.createElement('div');
    line.className = `log-line ${level === 'error' ? 'error' : level === 'success' ? 'success' : ''}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.innerHTML = `<span class="time">${time}</span><span>${escapeHtml(message)}</span>`;
    list.appendChild(line);
    while (list.children.length > 250) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  // 去掉文案里残留的 emoji，避免与左侧状态图标叠成「双图标」
  function stripEmoji(text) {
    return String(text).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
  }

  function toast(message, type = 'info') {
    const el = $('toast');
    // 单一线性状态图标，风格与工具栏一致；文案内 emoji 统一剥离
    const icon = type === 'success' ? '#i-toast-success' : type === 'error' ? '#i-toast-error' : '#i-toast-info';
    el.innerHTML = `<span class="toast-icon"><svg class="icon"><use href="${icon}"></use></svg></span><span>${escapeHtml(stripEmoji(message))}</span>`;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  function setCustomSelectValue(id, value) {
    const root = $(id);
    if (!root) return;
    const stringValue = String(value);
    root.dataset.value = stringValue;
    const option = root.querySelector(`.custom-select-menu button[data-value="${stringValue}"]`);
    const label = root.querySelector('.custom-select-label');
    if (label && option) label.textContent = option.querySelector('span').textContent;
    root.querySelectorAll('.custom-select-menu button[data-value]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.value === stringValue);
    });
  }

  function applyFontSize() {
    document.documentElement.style.setProperty('--editor-font', `${state.fontSize}px`);
    setCustomSelectValue('sizeSelect', state.fontSize);
  }

  const LINE_HEIGHTS = [1, 1.15, 1.5, 1.7, 2, 2.5, 3];

  function nextLineHeight(direction) {
    const current = Number(state.lineHeight);
    if (direction > 0) {
      const next = LINE_HEIGHTS.find((h) => h > current + 0.001);
      return next === undefined ? LINE_HEIGHTS[LINE_HEIGHTS.length - 1] : next;
    }
    const prev = [...LINE_HEIGHTS].reverse().find((h) => h < current - 0.001);
    return prev === undefined ? LINE_HEIGHTS[0] : prev;
  }

  function applyLineHeight() {
    document.documentElement.style.setProperty('--editor-line', String(state.lineHeight));
    // 菜单里没有的自定义值（如菜单增减产生的中间值）回退显示最近的预设
    let value = Number(state.lineHeight);
    if (!LINE_HEIGHTS.some((h) => h === value)) {
      const label = document.querySelector('#lineHeightSelect .custom-select-label');
      if (label) label.textContent = String(value);
      const root = $('lineHeightSelect');
      if (root) root.querySelectorAll('.custom-select-menu button').forEach((b) => b.classList.remove('selected'));
      return;
    }
    setCustomSelectValue('lineHeightSelect', value);
  }

  function applySyntaxHighlight() {
    document.body.classList.toggle('source-plain', !state.syntaxHighlight);
  }

  // 情绪色：全天四段都有配色，支持手动覆盖（auto/清晨/白天/黄昏/夜间）
  const MOODS = ['mood-morning', 'mood-day', 'mood-dusk', 'mood-night'];
  const MOOD_LABELS = {
    'mood-morning': '🌅 清晨',
    'mood-day': '☀️ 白昼',
    'mood-dusk': '🌇 黄昏',
    'mood-night': '🌙 夜间'
  };
  function moodByHour(hour) {
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 17) return 'day';
    if (hour >= 17 && hour < 19) return 'dusk';
    return 'night';
  }
  function currentMood() {
    const key = state.mood && state.mood !== 'auto'
      ? state.mood
      : moodByHour(new Date().getHours());
    return `mood-${key}`;
  }
  function applyMood() {
    const mood = currentMood();
    document.body.classList.remove(...MOODS);
    document.body.classList.add(mood);
    // 状态栏显示当前情绪色名称，让主题色"看得见"
    const label = $('statusMood');
    if (label) label.textContent = `${MOOD_LABELS[mood] || '☀️ 白昼'} · 情绪色`;
    // 菜单选中态同步
    document.querySelectorAll('[data-mood]').forEach((el) => {
      const val = el.dataset.mood;
      const active = val === 'auto' ? state.mood === 'auto' : `mood-${val}` === mood && state.mood !== 'auto';
      el.classList.toggle('active', active);
    });
  }
  function setMood(value) {
    state.mood = value;
    applyMood();
    saveEditorConfig({ mood: value });
    const text = value === 'auto'
      ? `已跟随时间 · 当前 ${MOOD_LABELS[currentMood()]}`
      : `已切换到 ${MOOD_LABELS[currentMood()]} 情绪色`;
    toast(text, 'success');
  }

  function applyTheme() {
    const dark = state.theme === 'dark';
    document.body.classList.toggle('theme-dark', dark);
    applyMood();
    const btn = $('btnToggleTheme');
    if (btn) {
      btn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
      btn.title = dark ? '切换到亮色主题' : '切换到暗色主题';
    }
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveEditorConfig({ theme: state.theme });
    toast(state.theme === 'dark' ? '晚安模式，已切到暗色 🌙' : '早安模式，已切到亮色 ☀️', 'success');
  }

  function saveLineHeight() {
    if (!state.config) return Promise.resolve();
    return api.saveConfig({
      ...state.config,
      editor: { ...state.config.editor, lineHeight: state.lineHeight }
    }).then((cfg) => { state.config = cfg; }).catch(() => {});
  }

  function setPublishStatus(level, text) {
    state.publish = { level, text };
    const dot = level === 'ok' ? 'ok' : level === 'busy' ? 'busy' : level === 'error' ? 'error' : '';
    const face = level === 'ok' ? '🌿' : level === 'busy' ? '🔄' : level === 'error' ? '⚠️' : '📤';
    $('statusPublish').innerHTML = `<span class="status-dot ${dot}"></span><span class="status-emoji">${face}</span>${escapeHtml(text)}`;
  }

  function formatSavedTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function updateDocStats() {
    const value = editor.value;
    const chars = value.length;
    const lines = value ? value.split('\n').length : 1;
    $('statusStats').textContent = `${chars.toLocaleString('zh-CN')} 字 · ${lines} 行`;
  }

  let lastSaveLevel = null;

  function updateStatus() {
    $('statusWorkspace').textContent = `工作区：${state.workspace || '未选择'}`;
    $('statusFile').textContent = `文件：${state.currentFile ? basename(state.currentFile) : '—'}`;

    // 文档状态：徽章已从头部移除，仅保留底部状态栏
    const saveLevel = state.dirty ? 'busy' : (state.currentFile ? 'ok' : '');
    let saveText;
    let saveEmoji;
    if (state.dirty) {
      saveText = '未保存';
      saveEmoji = '✏️';
    } else if (state.currentFile) {
      saveText = '已保存';
      saveEmoji = '✅';
    } else {
      saveText = '就绪';
      saveEmoji = '🌿';
    }
    // 从未保存 → 已保存时，状态点轻微回弹（情感化反馈）
    const justSaved = lastSaveLevel === 'busy' && saveLevel === 'ok';
    $('statusSave').innerHTML = `<span class="status-dot ${saveLevel}${justSaved ? ' saved-pop' : ''}"></span><span class="status-emoji">${saveEmoji}</span>${saveText}`;
    lastSaveLevel = saveLevel;

    // 目录树当前文件标记未保存
    tree.querySelectorAll('.tree-node').forEach((node) => {
      node.classList.toggle('dirty', Boolean(state.currentFile && state.dirty && node.dataset.path === state.currentFile));
    });
    updateCursor();
    updateDocStats();
  }

  function updateCursor() {
    const before = editor.value.slice(0, editor.selectionStart);
    const lines = before.split('\n');
    $('statusCursor').textContent = `行 ${lines.length}，列 ${lines[lines.length - 1].length + 1}`;
    syncOutlineToCursor();
  }

  function updateGutter() {
    const count = editor.value.split('\n').length;
    gutter.textContent = Array.from({ length: count }, (_unused, index) => String(index + 1)).join('\n');
    gutter.scrollTop = editor.scrollTop;
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 140);
  }

  let cachedHeadings = [];
  let scrollSyncLock = false;

  function renderPreview() {
    preview.innerHTML = window.MarkdownRender.render(editor.value);
    cachedHeadings = window.MarkdownRender.getHeadings(editor.value);
    renderOutline();
    renderOutlineRail();
  }

  // 编辑区滚动时按比例带动预览区滚动，避免来回触发用锁 + rAF
  function syncPreviewScroll() {
    const cfg = state.config && state.config.editor;
    if (!cfg || cfg.scrollSync === false) return;
    if (scrollSyncLock || document.body.classList.contains('mode-editor')) return;
    const body = $('previewBody');
    if (!body || body.scrollHeight <= body.clientHeight) return;
    const editorRange = editor.scrollHeight - editor.clientHeight;
    if (editorRange <= 0) return;
    const ratio = Math.min(1, Math.max(0, editor.scrollTop / editorRange));
    const previewRange = body.scrollHeight - body.clientHeight;
    scrollSyncLock = true;
    body.scrollTop = ratio * previewRange;
    syncPreviewOutlineScroll();
    requestAnimationFrame(() => { scrollSyncLock = false; });
  }

  // 光标所在行对应的标题，反向高亮大纲与本页目录
  function syncOutlineToCursor() {
    if (!cachedHeadings.length) return;
    const line = editor.value.slice(0, editor.selectionStart).split('\n').length - 1;
    let active = cachedHeadings[0];
    for (const heading of cachedHeadings) {
      if (heading.line <= line) active = heading;
      else break;
    }
    markOutlineActive(active.id);
    markOutlineRailActive(active.id);
    const item = document.querySelector(`.outline-item[data-id="${CSS.escape(active.id)}"]`);
    if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
  }

  // 统一菜单搜索：只过滤当前弹层里的动作，经典菜单栏不受影响
  function filterAppMenu(query) {
    const panel = $('appMenuPanel');
    if (!panel) return;
    const keyword = (query || '').trim().toLowerCase();
    panel.classList.toggle('searching', !!keyword);
    panel.querySelectorAll('.menu-group').forEach((group) => {
      let visible = 0;
      group.querySelectorAll('button').forEach((button) => {
        const text = `${button.textContent || ''} ${button.title || ''}`.toLowerCase();
        const show = !keyword || text.includes(keyword);
        button.classList.toggle('is-hidden', !show);
        if (show) visible += 1;
      });
      group.classList.toggle('is-hidden', visible === 0);
    });
  }

  // 经典菜单栏切换：把原始 nav 在标题栏与统一菜单弹层之间移动，所有事件监听保持不变
  function setClassicMenu(enabled, persist = true) {
    const topmenu = $('topmenu');
    const panel = $('appMenuPanel');
    const appMenu = $('appMenu');
    const titlebar = document.querySelector('.titlebar');
    const controls = document.querySelector('.window-controls');
    if (!topmenu || !panel || !appMenu || !titlebar || !controls) return;
    document.body.classList.toggle('classic-menu', enabled);
    const menuBtn = $('btnAppMenu');
    if (menuBtn) {
      menuBtn.title = enabled ? '使用紧凑菜单' : '菜单（Ctrl+K 搜索命令）';
      menuBtn.setAttribute('aria-label', enabled ? '使用紧凑菜单' : '打开菜单');
    }
    if (enabled) {
      titlebar.insertBefore(topmenu, controls);
    } else {
      const foot = panel.querySelector('.app-menu-foot');
      panel.insertBefore(topmenu, foot);
    }
    appMenu.classList.remove('open');
    document.querySelectorAll('.menu-group').forEach((group) => group.classList.remove('open'));
    if (!state.config) return;
    state.config.editor = { ...(state.config.editor || {}), classicMenu: enabled };
    if (!persist) return;
    api.saveConfig(state.config).then((saved) => { if (saved) state.config = saved; }).catch(() => {});
  }

  // 目录栏显隐：body class 控制布局，配置持久化到 editor.previewOutline
  function setPreviewOutlineVisible(visible, persist = true) {
    document.body.classList.toggle('preview-outline-hidden', !visible);
    const btn = $('btnTogglePreviewOutline');
    if (btn) {
      btn.classList.toggle('active', visible);
      btn.title = visible ? '隐藏标题导轨' : '显示标题导轨';
    }
    if (!state.config) return;
    state.config.editor = { ...(state.config.editor || {}), previewOutline: visible };
    if (!persist) return;
    api.saveConfig(state.config).then((saved) => { if (saved) state.config = saved; }).catch(() => {});
  }

  // 预览滚动时高亮当前所处章节对应的导轨横线
  function syncPreviewOutlineScroll() {
    const ticks = Array.from(document.querySelectorAll('.rail-tick'));
    if (!ticks.length) return;
    const previewTop = preview.getBoundingClientRect().top;
    let activeId = ticks[0].dataset.id;
    for (const tick of ticks) {
      const target = preview.querySelector(`[id="${CSS.escape(tick.dataset.id)}"]`);
      if (!target) continue;
      if (target.getBoundingClientRect().top - previewTop <= 24) activeId = tick.dataset.id;
      else break;
    }
    markOutlineRailActive(activeId);
    markOutlineActive(activeId);
  }

  // ---------- 大纲导航 ----------
  function renderOutline() {
    const box = $('outline');
    if (!box) return;
    const headings = window.MarkdownRender.getHeadings(editor.value);
    if (!headings.length) {
      box.innerHTML = '<div class="outline-empty"><span class="empty-emoji">🗺️</span>还没有标题呢<br>用 # 到 ###### 写一行<br>目录就长出来了</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    headings.forEach((heading) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `outline-item level-${heading.level}`;
      btn.dataset.line = String(heading.line);
      btn.dataset.id = heading.id;
      btn.title = `${'#'.repeat(heading.level)} ${heading.text}`;
      btn.innerHTML = `<span class="outline-indent" style="width:${(heading.level - 1) * 12}px"></span><span class="outline-text">${escapeHtml(heading.text || '（无标题）')}</span>`;
      btn.addEventListener('click', () => {
        focusLine(heading.line + 1);
        // 预览区滚动到对应标题
        const target = preview.querySelector(`[id="${CSS.escape(heading.id)}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        markOutlineActive(heading.id);
      });
      frag.appendChild(btn);
    });
    box.innerHTML = '';
    box.appendChild(frag);
  }

  function markOutlineActive(id) {
    document.querySelectorAll('.outline-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.id === id);
    });
  }

  // ---------- 编辑区右侧标题导轨 ----------
  // 每根横线对应一个标题，长度按层级递减；当前标题红色；悬停浮出标题文字；点击跳到该行。
  function renderOutlineRail() {
    const list = $('outlineRailList');
    if (!list) return;
    const headings = cachedHeadings;
    if (!headings.length) {
      document.body.classList.remove('rail-active');
      list.innerHTML = '';
      return;
    }
    const frag = document.createDocumentFragment();
    headings.forEach((heading) => {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = `rail-tick level-${Math.min(6, Math.max(1, heading.level || 1))}`;
      tick.dataset.id = heading.id;
      tick.dataset.line = String(heading.line);
      tick.dataset.title = heading.text || '（无标题）';
      tick.setAttribute('aria-label', `跳转到：${tick.dataset.title}`);
      tick.addEventListener('click', () => {
        focusLine(heading.line + 1);
        markOutlineRailActive(heading.id);
        const target = preview.querySelector(`[id="${CSS.escape(heading.id)}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      frag.appendChild(tick);
    });
    list.innerHTML = '';
    list.appendChild(frag);
    document.body.classList.add('rail-active');
  }

  function markOutlineRailActive(id) {
    document.querySelectorAll('.rail-tick').forEach((tick) => {
      tick.classList.toggle('active', tick.dataset.id === id);
    });
  }

  function setSideTab(tab) {
    document.body.classList.toggle('outline-active', tab === 'outline');
    document.querySelectorAll('.sidebar-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sideTab === tab);
    });
    if (tab === 'outline') renderOutline();
  }

  function resetHistory(content) {
    history.stack = [String(content || '')];
    history.index = 0;
  }

  function pushHistory() {
    if (historyLocked) return;
    const value = editor.value;
    if (history.stack[history.index] === value) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(value);
    if (history.stack.length > 300) history.stack.shift();
    history.index = history.stack.length - 1;
  }

  function undo() {
    if (history.index <= 0) {
      toast('没有可以撤销的操作啦');
      return;
    }
    historyLocked = true;
    history.index -= 1;
    editor.value = history.stack[history.index];
    editor.setSelectionRange(0, 0);
    historyLocked = false;
    markDirty();
    updateCursor();
    toast('已撤销，回到上一步 ↩️', 'success');
  }

  function redo() {
    if (history.index >= history.stack.length - 1) {
      toast('没有可以重做的操作啦');
      return;
    }
    historyLocked = true;
    history.index += 1;
    editor.value = history.stack[history.index];
    editor.setSelectionRange(editor.value.length, editor.value.length);
    historyLocked = false;
    markDirty();
    updateCursor();
    toast('已重做，继续往前 ↪️', 'success');
  }

  function markDirty() {
    pushHistory();
    state.dirty = true;
    const tab = activeTab();
    if (tab) {
      tab.content = editor.value;
      tab.dirty = true;
      tab.history.stack = history.stack.slice();
      tab.history.index = history.index;
    }
    updateStatus();
    updateGutter();
    updateHighlight();
    schedulePreview();
    renderTabs();
    scheduleDraftBackup();
  }

  function saveEditorConfig(patch) {
    if (!state.config) return Promise.resolve();
    return api.saveConfig({
      ...state.config,
      editor: { ...state.config.editor, ...patch }
    }).then((cfg) => { state.config = cfg; }).catch(() => {});
  }

  // 工具栏视图按钮：图标随当前模式变化，点击在 分屏 → 仅编辑器 → 仅预览 间循环
  const VIEW_CYCLE = [
    { mode: 'split', icon: '#i-view-split', label: '分屏显示' },
    { mode: 'editor', icon: '#i-view-editor', label: '仅编辑器' },
    { mode: 'preview', icon: '#i-view-preview', label: '仅预览' }
  ];

  function syncViewButton() {
    const btn = $('btnCycleView');
    const icon = $('cycleViewIcon');
    const info = VIEW_CYCLE.find((v) => v.mode === state.viewMode) || VIEW_CYCLE[0];
    if (icon) icon.setAttribute('href', info.icon);
    if (btn) btn.title = `视图：${info.label}（点击切换）`;
  }

  function cycleViewMode() {
    const idx = VIEW_CYCLE.findIndex((v) => v.mode === state.viewMode);
    const next = VIEW_CYCLE[(idx + 1 + VIEW_CYCLE.length) % VIEW_CYCLE.length];
    setViewMode(next.mode);
  }

  function setViewMode(mode, persist = true) {
    state.viewMode = mode;
    document.body.classList.remove('mode-split', 'mode-editor', 'mode-preview');
    document.body.classList.add(`mode-${mode}`);
    syncFocusBar();
    syncViewButton();
    if (!persist) return;
    // 情感化：主动切换视图时主区域轻微淡入，提示状态变化
    document.body.classList.remove('view-transition');
    void document.body.offsetWidth;
    document.body.classList.add('view-transition');
    setTimeout(() => document.body.classList.remove('view-transition'), 260);
    saveEditorConfig({ viewMode: mode });
  }

  function syncFocusBar() {
    document.querySelectorAll('#focusBar [data-focus-view]').forEach((button) => {
      const active = button.dataset.focusView === state.viewMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  function setFocusMode(force, persist = true) {
    state.focusMode = typeof force === 'boolean' ? force : !state.focusMode;
    document.body.classList.toggle('focus-mode', state.focusMode);
    if (state.focusMode) {
      syncFocusBar();
      if (state.viewMode !== 'preview') editor.focus();
    } else {
      closeFloatingMenus();
    }
    if (!persist) return;
    saveEditorConfig({ focusMode: state.focusMode });
  }

  function applyLayout() {
    const main = $('mainPane');
    main.style.setProperty('--editor-fr', `${state.editorFr}fr`);
    main.style.setProperty('--preview-fr', `${state.previewFr}fr`);
  }

  function toggleSidebar(force) {
    state.sidebarCollapsed = typeof force === 'boolean' ? force : !state.sidebarCollapsed;
    document.body.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    saveEditorConfig({ sidebarCollapsed: state.sidebarCollapsed });
  }

  // 边缘拖拽唤出侧栏：从把手按下向右拖，实时改变侧栏宽度；松手超过阈值即展开，单击也展开
  function bindSidebarRailDrag() {
    const rail = $('sidebarRail');
    const main = $('mainPane');
    const THRESHOLD = 90; // 拖出超过此宽度即判定为展开
    const MIN_W = 10;
    let dragging = false;
    let startX = 0;
    let dragW = MIN_W;

    rail.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      dragW = MIN_W;
      document.body.classList.add('sidebar-dragging', 'resizing');
      main.style.setProperty('--drag-w', `${MIN_W}px`);
    });

    const onMove = (event) => {
      if (!dragging) return;
      const delta = event.clientX - startX;
      dragW = Math.max(MIN_W, Math.min(360, MIN_W + delta));
      main.style.setProperty('--drag-w', `${dragW}px`);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('sidebar-dragging', 'resizing');
      main.style.removeProperty('--drag-w');
      // 拖动超过阈值，或只是单击（未明显拖动）→ 展开侧栏
      if (dragW >= THRESHOLD || dragW <= MIN_W + 4) {
        toggleSidebar(false);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function bindSplitter() {
    const splitter = $('splitterMain');
    const main = $('mainPane');
    let dragging = false;

    const onMove = (event) => {
      if (!dragging) return;
      const rect = main.getBoundingClientRect();
      const padding = 10;
      const rail = state.sidebarCollapsed ? 10 : parseFloat(getComputedStyle(main).getPropertyValue('--sidebar-w')) || 300;
      // 可分配宽度 = 主区宽 - 左右 padding - 侧栏(或折叠轨) - 分隔条 6px - panel margin 合计
      const usable = rect.width - padding * 2 - rail - 6 - 20;
      if (usable <= 0) return;
      const x = event.clientX - rect.left - padding - rail;
      const ratio = Math.min(0.85, Math.max(0.15, x / usable));
      state.editorFr = Number(ratio.toFixed(4));
      state.previewFr = Number((1 - ratio).toFixed(4));
      applyLayout();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveEditorConfig({ editorFr: state.editorFr, previewFr: state.previewFr });
    };
    splitter.addEventListener('mousedown', (event) => {
      if (state.viewMode !== 'split') return;
      event.preventDefault();
      dragging = true;
      splitter.classList.add('dragging');
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function toggleLog(force) {
    state.logOpen = typeof force === 'boolean' ? force : !state.logOpen;
    $('logDrawer').classList.toggle('open', state.logOpen);
  }

  // 目录树的未发布更改标识：把扫描到的变更相对路径映射到树节点
  function normRel(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').toLowerCase();
  }

  // 计算某文件夹下的变更状态（基于相对路径前缀，含已删除但树里不存在的文件）
  function collectDirMark(node) {
    const statuses = new Set();
    let count = 0;
    const dirRel = state.workspace ? normRel(String(node.path).slice(String(state.workspace).length)) : '';
    const prefix = dirRel ? dirRel + '/' : '';
    for (const [rel, st] of state.publishMarks) {
      if (prefix && rel.startsWith(prefix)) { statuses.add(st); count += 1; }
    }
    return { statuses, count };
  }

  function markBadgeFor(status) {
    if (status === 'modified') return { cls: 'pm-modified', text: 'M', title: '有未发布的修改' };
    if (status === 'added') return { cls: 'pm-added', text: 'A', title: '新增，尚未发布' };
    if (status === 'deleted') return { cls: 'pm-deleted', text: 'D', title: '线上有、本地已删除' };
    return null;
  }

  function renderTreeNodes(nodes, container, level) {
    nodes.forEach((node) => {
      const row = document.createElement('div');
      row.className = `tree-node ${node.type}`;
      row.style.paddingLeft = `${8 + level * 10}px`;
      row.dataset.path = node.path;
      row.draggable = true;
      const displayName = node.label || node.name;
      if (node.label && node.label !== node.name) row.title = `实际目录：${node.name}`;
      if (node.path === state.currentFile) row.classList.add('active');

      const isExpanded = expandedDirs.has(node.path);
      const caret = node.type === 'dir' ? (isExpanded ? '▾' : '▸') : '';
      const icon = node.type === 'dir' ? 'i-folder-modern' : (node.type === 'image' ? 'i-image' : 'i-file-modern');

      // 未发布更改徽标：文件按自身状态，文件夹聚合后代（取优先级最高的状态 + 数量）
      let badgeHtml = '';
      if (node.type === 'file' && state.publishMarksActive) {
        const rel = state.workspace ? normRel(String(node.path).slice(String(state.workspace).length)) : '';
        const st = state.publishMarks.get(rel);
        const badge = markBadgeFor(st);
        if (badge) badgeHtml = `<span class="pub-mark ${badge.cls}" title="${badge.title}">${badge.text}</span>`;
      } else if (node.type === 'dir' && state.publishMarksActive) {
        const agg = collectDirMark(node);
        if (agg.count) {
          const priority = ['modified', 'added', 'deleted'].find((s) => agg.statuses.has(s));
          const badge = markBadgeFor(priority);
          badgeHtml = `<span class="pub-mark dir-mark ${badge.cls}" title="${agg.count} 个文件有未发布更改">${badge.text}</span>`
            + `<span class="pub-mark-count">${agg.count}</span>`;
          row.classList.add('has-pub-changes');
        }
      }
      row.innerHTML = `<span class="caret">${caret}</span><svg class="icon node-icon"><use href="#${icon}"></use></svg><span class="node-name">${escapeHtml(displayName)}</span>${badgeHtml}`;

      row.addEventListener('click', () => {
        if (node.type === 'dir') {
          if (expandedDirs.has(node.path)) expandedDirs.delete(node.path);
          else expandedDirs.add(node.path);
          refreshTree();
        } else if (node.type === 'image') {
          openImagePreview(node.path);
        } else {
          openFile(node.path);
        }
      });

      container.appendChild(row);
      if (node.type === 'dir' && isExpanded && node.children) {
        renderTreeNodes(node.children, container, level + 1);
      }
    });
  }

  async function refreshTree() {
    try {
      state.tree = await api.getTree();
      tree.innerHTML = '';
      if (!state.tree.length) {
        tree.innerHTML = '<div class="tree-empty">未选择工作区，或工作区为空。<br>点击右上角“选择”打开本地文件夹。</div>';
        return;
      }
      renderTreeNodes(state.tree, tree, 0);
    } catch (err) {
      log(`读取目录树失败：${err.message}`, 'error');
    }
  }

  // 自动发布只由 autoPublish 控制；手动预览/发布只需仓库参数完整
  function shouldAutoPublish() {
    const gh = state.config && state.config.github;
    if (!gh) return false;
    return gh.autoPublish !== undefined ? Boolean(gh.autoPublish) : Boolean(gh.enabled);
  }

  // 后台扫描未发布更改并更新目录树标识（静默失败、节流、无 GitHub 配置时跳过）
  async function scanPublishMarks() {
    if (publishingMarksScan) return;
    const gh = (state.config && state.config.github) || {};
    if (!state.workspace || !gh.owner || !gh.repo || !gh.token) {
      // 没有可用的 GitHub 配置：清掉旧标识
      if (state.publishMarks.size || state.publishMarksActive) {
        state.publishMarks = new Map();
        state.publishMarksActive = false;
        refreshTree();
      }
      return;
    }
    publishingMarksScan = true;
    try {
      const result = await api.scanPublishChanges();
      applyPublishChangesToMarks(result);
      await refreshTree();
    } catch (err) {
      // 静默：网络/权限问题不影响正常使用，仅在日志里留痕
      log(`未发布更改标识扫描失败：${cleanError(err)}`);
    } finally {
      publishingMarksScan = false;
    }
  }

  // 把一次扫描结果转换成目录树标识映射
  function applyPublishChangesToMarks(result) {
    const marks = new Map();
    for (const change of (result && result.changes) || []) {
      let rel = '';
      if (change.filePath && state.workspace) {
        rel = normRel(String(change.filePath).slice(String(state.workspace).length));
      } else if (change.relative) {
        rel = normRel(change.relative);
      } else if (change.repoPath) {
        const prefix = normRel(result.prefix);
        let rp = normRel(change.repoPath);
        if (prefix && rp.startsWith(prefix + '/')) rp = rp.slice(prefix.length + 1);
        rel = rp;
      }
      if (rel && change.status) marks.set(rel, change.status);
    }
    state.publishMarks = marks;
    state.publishMarksActive = true;
  }

  function scheduleScanPublishMarks(delay = 400) {
    if (publishMarksTimer) clearTimeout(publishMarksTimer);
    publishMarksTimer = setTimeout(() => { publishMarksTimer = null; scanPublishMarks(); }, delay);
  }

  // 从命令行 / 拖放到应用图标打开的文件：工作区已在主进程定位到其所在目录
  async function openFilesFromShell(files) {
    if (!Array.isArray(files) || !files.length) return;
    try {
      const ws = await api.getCurrentWorkspace();
      if (ws) {
        state.workspace = ws;
        recordRecentWorkspace(ws);
        log(`已定位工作区：${ws}`);
      }
      await refreshTree();
      for (const file of files) await openFile(file);
      updateStatus();
      toast(`已打开 ${files.length} 个文件`, 'success');
    } catch (err) {
      toast(`打开失败：${err.message}`, 'error');
      log(`打开拖放文件失败：${err.message}`, 'error');
    }
  }

  // 主进程已把 currentWorkspace 指向 path；这里只负责渲染层状态切换
  async function activateWorkspace(path, message = '工作区已打开') {
    state.workspace = path;
    state.tabs = [];
    state.activeTabId = '';
    state.currentFile = '';
    state.dirty = false;
    state.lastSavedAt = null;
    expandedDirs.clear();
    editor.value = '';
    resetHistory('');
    updateStatus();
    updateGutter();
    updateHighlight();
    renderPreview();
    renderTabs();
    await refreshTree();
    recordRecentWorkspace(path);
    // 切换工作区后同步对应仓库的发布配置
    try {
      if (state.config) state.config.github = (await api.getGithubConfig()) || state.config.github;
    } catch (_) { /* 沿用当前配置 */ }
    // 切换工作区：清掉旧仓库的标识，再按新仓库扫描
    state.publishMarks = new Map();
    state.publishMarksActive = false;
    scheduleScanPublishMarks(500);
    if (message) toast(message, 'success');
    log(`已选择工作区：${path}`, 'success');
  }

  async function chooseWorkspace() {
    try {
      const path = await api.chooseWorkspace();
      if (!path) return;
      await activateWorkspace(path, '工作区已打开');
    } catch (err) {
      toast(err.message, 'error');
      log(err.message, 'error');
    }
  }

  async function openRecentWorkspace(workspacePath) {
    try {
      const path = await api.openWorkspace(workspacePath);
      if (!path) return false;
      await activateWorkspace(path, '已切换到最近工作区');
      return true;
    } catch (err) {
      toast(err.message, 'error');
      log(err.message, 'error');
      return false;
    }
  }

  // 弹窗层级管理：后打开的弹窗自动置顶，避免嵌套弹窗（如发布弹窗里点撤销弹出的确认框）被父弹窗遮挡
  (function setupModalStacking() {
    let topZ = 50;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const el = mutation.target;
        if (el.classList && el.classList.contains('modal-backdrop') && el.classList.contains('open')) {
          el.style.zIndex = String(++topZ);
        }
      }
    });
    document.querySelectorAll('.modal-backdrop').forEach((el) => {
      observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  })();

  function askConfirm(title, message) {
    return new Promise((resolve) => {
      const parts = String(message || '').split('\n');
      $('confirmTitle').textContent = title;
      $('confirmMessage').textContent = parts[0] || '';
      const detail = $('confirmDetail');
      detail.textContent = parts.slice(1).join('\n');
      detail.style.display = parts.length > 1 ? '' : 'none';
      $('confirmModal').classList.add('open');
      const ok = $('btnConfirmOk');
      const cancel = $('btnConfirmCancel');
      const cleanup = (result) => {
        $('confirmModal').classList.remove('open');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    });
  }

  // 关闭窗口确认：无未保存内容直接放行；否则弹自定义三按钮弹窗
  async function handleWindowCloseConfirm() {
    syncActiveTab();
    const dirtyTabs = state.tabs.filter((tab) => tab.dirty);
    if (!dirtyTabs.length) {
      api.confirmClose(true);
      return;
    }

    $('closeConfirmDetail').textContent = dirtyTabs.map((tab) => tab.name).join('、');
    const modal = $('closeConfirmModal');
    modal.classList.add('open');

    const cleanup = () => {
      modal.classList.remove('open');
      $('btnCloseCancel').removeEventListener('click', onCancel);
      $('btnCloseDiscard').removeEventListener('click', onDiscard);
      $('btnCloseSave').removeEventListener('click', onSave);
    };
    const onCancel = () => { cleanup(); api.confirmClose(false); };
    const onDiscard = () => { cleanup(); api.confirmClose(true); };
    const onSave = async () => {
      cleanup();
      // 逐个保存脏标签；任一失败则中止关闭，避免丢数据
      for (const tab of dirtyTabs) {
        if (!tab.path) {
          toast(`「${tab.name}」尚未命名，请先另存为`, 'error');
          api.confirmClose(false);
          return;
        }
        try {
          await api.writeFile(tab.path, tab.content);
          tab.dirty = false;
        } catch (err) {
          toast(`保存「${tab.name}」失败：${err.message}`, 'error');
          api.confirmClose(false);
          return;
        }
      }
      api.confirmClose(true);
    };
    $('btnCloseCancel').addEventListener('click', onCancel);
    $('btnCloseDiscard').addEventListener('click', onDiscard);
    $('btnCloseSave').addEventListener('click', onSave);
  }

  // ---------- 目录树右键菜单 ----------
  function dirnameOf(filePath) {
    const value = String(filePath || '');
    const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    return index > 0 ? value.slice(0, index) : '';
  }

  // 转成相对工作区的路径（正斜杠），可直接写进 Markdown 图片引用
  function relativeToWorkspace(filePath) {
    const value = String(filePath || '').replace(/\\/g, '/');
    const ws = state.workspace ? String(state.workspace).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (ws && value.toLowerCase().startsWith(ws.toLowerCase() + '/')) {
      return value.slice(ws.length + 1);
    }
    return basename(filePath);
  }

  // 绝对路径转 file:// URL（供图片预览大图使用）
  function toFileUrl(filePath) {
    return encodeURI('file:///' + String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  }

  function openImagePreview(filePath) {
    const viewer = $('imageViewer');
    const img = $('imageViewerImg');
    if (!viewer || !img) return;
    state.imagePreviewPath = filePath;
    $('imageViewerName').textContent = basename(filePath);
    img.src = toFileUrl(filePath);
    img.onerror = () => toast('图片加载失败', 'error');
    viewer.classList.add('open');
  }

  function closeImagePreview() {
    const viewer = $('imageViewer');
    if (!viewer) return;
    viewer.classList.remove('open');
    state.imagePreviewPath = '';
    const img = $('imageViewerImg');
    if (img) img.removeAttribute('src');
  }

  async function copyToClipboard(text, successMsg) {
    try {
      await api.copyText(text);
      toast(successMsg || '已复制到剪贴板', 'success');
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
    }
  }

  function openPrompt(options) {
    const opts = options || {};
    return new Promise((resolve) => {
      $('promptTitle').textContent = opts.title || '请输入';
      const desc = $('promptDesc');
      desc.textContent = opts.desc || '';
      desc.style.display = opts.desc ? '' : 'none';
      $('promptLabel').textContent = opts.label || '名称';
      const input = $('promptInput');
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
      const ok = $('btnPromptConfirm');
      const cancel = $('btnPromptCancel');
      ok.textContent = opts.confirmText || '确定';
      $('promptIconUse').setAttribute('href', `#${opts.icon || 'i-edit'}`);
      $('promptModal').classList.add('open');

      const cleanup = (result) => {
        $('promptModal').classList.remove('open');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        $('promptModal').removeEventListener('click', onBackdrop);
        resolve(result);
      };
      const onOk = () => {
        const value = input.value.trim();
        if (!value) {
          toast('名称不能为空', 'error');
          input.focus();
          return;
        }
        cleanup(value);
      };
      const onCancel = () => cleanup(null);
      const onKey = (event) => {
        if (event.key === 'Enter') { event.preventDefault(); onOk(); }
        else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      };
      const onBackdrop = (event) => { if (event.target === $('promptModal')) onCancel(); };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      $('promptModal').addEventListener('click', onBackdrop);
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  function closeContextMenu() {
    $('contextMenu').classList.remove('open');
    contextTarget = null;
  }

  function displayNodeName(node) {
    return (node && node.label) || (node && node.name) || '';
  }

  function showContextMenu(clientX, clientY, target) {
    contextTarget = target;
    const menu = $('contextMenu');
    const isDir = target && target.type === 'dir';
    const isImage = target && target.type === 'image';
    const items = [];
    if (isDir) {
      items.push({ icon: 'i-file-plus', label: '在此处新建文件', action: 'newFile' });
      items.push({ icon: 'i-new-folder', label: '新建文件夹', action: 'newFolder' });
      items.push({ divider: true });
      items.push({ icon: 'i-explorer', label: '在资源管理器中打开', action: 'reveal' });
      items.push({ icon: 'i-folder', label: '移动到文件夹…', action: 'move' });
      items.push({ icon: 'i-edit', label: '重命名', action: 'rename' });
      items.push({ icon: 'i-min', label: '从目录树移出', action: 'excludeDir' });
      items.push({ icon: 'i-trash', label: '删除到回收站', action: 'delete', danger: true });
    } else if (isImage) {
      items.push({ icon: 'i-image', label: '预览图片', action: 'openImage' });
      items.push({ divider: true });
      items.push({ icon: 'i-file', label: '复制名字', action: 'copyName' });
      items.push({ icon: 'i-link', label: '复制相对路径（写进 Markdown）', action: 'copyRelPath' });
      items.push({ divider: true });
      items.push({ icon: 'i-explorer', label: '在资源管理器中显示', action: 'reveal' });
      items.push({ icon: 'i-folder', label: '移动到文件夹…', action: 'move' });
      items.push({ icon: 'i-edit', label: '重命名', action: 'rename' });
      items.push({ icon: 'i-trash', label: '删除到回收站', action: 'delete', danger: true });
    } else if (target) {
      items.push({ icon: 'i-file', label: '打开', action: 'open' });
      items.push({ icon: 'i-explorer', label: '在资源管理器中显示', action: 'reveal' });
      items.push({ divider: true });
      items.push({ icon: 'i-refresh', label: '版本历史', action: 'history' });
      items.push({ icon: 'i-pdf', label: '导出为 PDF', action: 'exportPdf' });
      items.push({ divider: true });
      items.push({ icon: 'i-folder', label: '移动到文件夹…', action: 'move' });
      items.push({ icon: 'i-edit', label: '重命名', action: 'rename' });
      items.push({ icon: 'i-trash', label: '删除到回收站', action: 'delete', danger: true });
    } else {
      items.push({ icon: 'i-file-plus', label: '新建 Markdown 文件', action: 'newFile' });
      items.push({ icon: 'i-new-folder', label: '新建文件夹', action: 'newFolder' });
      items.push({ divider: true });
      items.push({ icon: 'i-explorer', label: '在资源管理器中打开工作区', action: 'revealRoot' });
      items.push({ icon: 'i-refresh', label: '刷新目录', action: 'refresh' });
      items.push({ icon: 'i-folder', label: '管理已移出的文件夹…', action: 'manageExcluded' });
    }
    menu.innerHTML = items.map((item) => item.divider
      ? '<div class="context-divider"></div>'
      : `<button type="button" class="context-item ${item.danger ? 'danger' : ''}" data-action="${item.action}"><svg class="icon"><use href="#${item.icon}"></use></svg><span>${escapeHtml(item.label)}</span></button>`
    ).join('');

    menu.classList.add('open');
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    const rect = menu.getBoundingClientRect();
    const left = clientX + rect.width > window.innerWidth - 8 ? Math.max(8, clientX - rect.width) : clientX;
    const top = clientY + rect.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - rect.height - 8) : clientY;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  async function openExcludedManager() {
    const list = await api.listExcludedDirs();
    const container = $('excludedList');
    if (!list.length) {
      container.innerHTML = '<div class="history-empty">还没有移出任何文件夹。<br>在工作区目录树中右键文件夹，选择「从目录树移出」即可。</div>';
    } else {
      container.innerHTML = list.map((item) => `
        <div class="excluded-item">
          <svg class="icon"><use href="#i-folder"></use></svg>
          <div class="excluded-info">
            <div class="excluded-name">${escapeHtml(basename(item.path))}</div>
            <div class="excluded-rel">${escapeHtml(item.relative)}</div>
          </div>
          <button type="button" class="excluded-restore" data-rel="${escapeHtml(item.relative)}">恢复显示</button>
        </div>`).join('');
      container.querySelectorAll('.excluded-restore').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            await api.restoreExcludedDir(button.dataset.rel);
            await refreshTree();
            await openExcludedManager();
            toast('已恢复显示', 'success');
          } catch (err) {
            toast(`恢复失败：${err.message}`, 'error');
          }
        });
      });
    }
    $('excludedModal').classList.add('open');
  }

  // 统一按正斜杠比较路径，避免 Windows 反斜杠与树节点路径混用
  function normalizedPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function isInsideDir(child, dir) {
    const c = normalizedPath(child);
    const d = normalizedPath(dir);
    return c === d || c.startsWith(d + '/');
  }

  function samePath(a, b) {
    return !!a && !!b && normalizedPath(a) === normalizedPath(b);
  }

  function flattenFolders(nodes, depth, out) {
    for (const node of (nodes || [])) {
      if (node.type !== 'dir') continue;
      out.push({ path: node.path, name: displayNodeName(node), rel: relativeToWorkspace(node.path), depth });
      flattenFolders(node.children, depth + 1, out);
    }
    return out;
  }

  // 文件夹选择器：列出工作区全部目录，禁用「当前位置」和源目录自身/子目录
  function openMovePicker(source, folders) {
    return new Promise((resolve) => {
      const modal = $('moveModal');
      const list = $('moveFolderList');
      const confirm = $('btnMoveConfirm');
      const cancel = $('btnMoveCancel');
      const currentParent = dirnameOf(source.path);
      const rootPath = String(state.workspace || '').replace(/\/+$/, '');
      const options = [
        { path: rootPath, name: '工作区根目录', rel: '', depth: 0 },
        ...folders
      ];
      const isValid = (folder) => !samePath(folder.path, currentParent)
        && !(source.type === 'dir' && isInsideDir(folder.path, source.path));
      $('moveCurrent').innerHTML = `<svg class="icon"><use href="#i-folder"></use></svg><span>当前位置</span><span class="move-current-path">${escapeHtml(relativeToWorkspace(currentParent) || rootPath)}</span>`;

      let selected = -1;
      function render() {
        list.innerHTML = options.map((folder, index) => {
          const blocked = !isValid(folder);
          const hint = samePath(folder.path, currentParent) ? '当前位置' : (blocked ? '不可选' : '');
          const padding = 11 + folder.depth * 14;
          return `<button type="button" class="move-folder-item ${selected === index ? 'selected' : ''}" data-index="${index}" style="padding-left:${padding}px" ${blocked ? 'disabled' : ''}>`
            + '<svg class="icon"><use href="#i-folder"></use></svg>'
            + `<span class="move-folder-info"><span class="move-folder-name">${escapeHtml(folder.name)}</span><span class="move-folder-rel">${escapeHtml(folder.rel || '/')}</span></span>`
            + (hint ? `<span class="move-folder-hint">${hint}</span>` : '')
            + '</button>';
        }).join('');
        confirm.disabled = selected < 0;
      }
      selected = options.findIndex(isValid);
      render();

      const cleanup = (result) => {
        modal.classList.remove('open');
        list.removeEventListener('click', onPick);
        confirm.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onPick = (event) => {
        const button = event.target.closest('.move-folder-item');
        if (!button || button.disabled) return;
        selected = Number(button.dataset.index);
        render();
      };
      const onOk = () => { if (selected >= 0) cleanup(options[selected].path); };
      const onCancel = () => cleanup(null);
      const onBackdrop = (event) => { if (event.target === modal) onCancel(); };
      const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        else if (event.key === 'Enter' && selected >= 0) { event.preventDefault(); onOk(); }
      };
      list.addEventListener('click', onPick);
      confirm.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      modal.classList.add('open');
      setTimeout(() => list.querySelector('.move-folder-item.selected')?.focus(), 30);
    });
  }

  // 移动后把旧路径前缀换成新路径，保留原有分隔符
  function remapMovedPath(value, oldRaw, newRaw) {
    if (!value) return value;
    if (value === oldRaw) return newRaw;
    const lower = String(value).toLowerCase();
    const oldLower = String(oldRaw).toLowerCase();
    for (const sep of ['\\', '/']) {
      if (lower.startsWith(oldLower + sep)) return newRaw + value.slice(oldRaw.length);
    }
    return value;
  }

  async function handleContextAction(action, target) {
    // 图片相关操作不依赖工作区
    if (action === 'openImage' && target) {
      openImagePreview(target.path);
      return;
    }
    if (action === 'copyName' && target) {
      await copyToClipboard(basename(target.path), '已复制文件名');
      return;
    }
    if (action === 'copyRelPath' && target) {
      await copyToClipboard(relativeToWorkspace(target.path), '已复制相对路径');
      return;
    }
    if (!state.workspace) {
      toast('先选一个工作区文件夹吧 📁', 'error');
      return;
    }
    const parentDir = target
      ? (target.type === 'dir' ? target.path : dirnameOf(target.path))
      : state.workspace;
    try {
      if (action === 'newFile' || action === 'newFolder') {
        const isFolder = action === 'newFolder';
        const value = await openPrompt({
          title: isFolder ? '新建文件夹' : '新建 Markdown 文件',
          desc: `创建位置：${parentDir}`,
          label: isFolder ? '文件夹名称' : '文件名',
          value: '',
          placeholder: isFolder ? '新建文件夹' : '未命名文档.md',
          confirmText: isFolder ? '创建文件夹' : '创建并打开',
          icon: isFolder ? 'i-new-folder' : 'i-file-plus'
        });
        if (value === null) return;
        const created = isFolder
          ? await api.createFolder(parentDir, value)
          : await api.createFile(parentDir, value);
        if (isFolder) expandedDirs.add(created.path);
        await refreshTree();
        if (isFolder) toast(`已新建文件夹：${created.name}`, 'success');
        else await openFile(created.path);
        return;
      }
      if (!target) return;
      if (action === 'open') {
        await openFile(target.path);
      } else if (action === 'excludeDir') {
        const ok = await askConfirm(
          `从目录树移出「${displayNodeName(target)}」？`,
          '文件夹仍会保留在磁盘上，只是不再显示在目录树中。\n可在目录树空白处右键 →「管理已移出的文件夹」恢复。'
        );
        if (!ok) return;
        await api.excludeDir(target.path);
        if (target.type === 'dir') expandedDirs.delete(target.path);
        await refreshTree();
        toast(`已移出目录树：${displayNodeName(target)}`, 'success');
        log(`已移出目录树：${target.path}`, 'success');
      } else if (action === 'manageExcluded') {
        await openExcludedManager();
      } else if (action === 'history' || action === 'exportPdf') {
        // 先切换到右键的目标文件，确保操作对象是它
        if (state.currentFile !== target.path) await openFile(target.path);
        if (action === 'history') await openHistory();
        else await exportPdf();
      } else if (action === 'reveal' || action === 'revealRoot') {
        await api.revealPath(action === 'revealRoot' ? state.workspace : target.path);
      } else if (action === 'refresh') {
        await refreshTree();
      } else if (action === 'move') {
        const currentInside = !!state.currentFile && isInsideDir(state.currentFile, target.path);
        if (state.dirty && currentInside) {
          const saved = await saveFile({ silent: true, skipAuto: true });
          if (!saved) return;
        }
        const folders = flattenFolders(await api.getTree(), 0, []);
        const destination = await openMovePicker(target, folders);
        if (!destination) return;
        const result = await api.movePath(target.path, destination);
        if (target.type === 'dir') {
          const updated = new Set();
          for (const path of expandedDirs) updated.add(remapMovedPath(path, target.path, result.path));
          expandedDirs.clear();
          updated.forEach((path) => expandedDirs.add(path));
        }
        expandedDirs.add(dirnameOf(result.path));
        state.tabs.forEach((tab) => {
          tab.path = remapMovedPath(tab.path, target.path, result.path);
        });
        if (state.currentFile) {
          const movedTo = remapMovedPath(state.currentFile, target.path, result.path);
          if (movedTo !== state.currentFile) {
            state.currentFile = movedTo;
            updateStatus();
            renderTabs();
          }
        }
        await refreshTree();
        toast(`已移动到：${relativeToWorkspace(dirnameOf(result.path)) || '工作区根目录'}`, 'success');
        log(`已移动：${basename(result.path)} → ${result.path}`, 'success');
        if (result.vitepressSynced) {
          log(`已同步 ${result.vitepressSynced} 处 VitePress 侧边栏条目，发布后生效。`, 'success');
        }
      } else if (action === 'rename') {
        const oldName = basename(target.path);
        const value = await openPrompt({
          title: target.type === 'dir' ? '重命名文件夹' : '重命名文件',
          desc: '输入新名称；文档内的引用与链接不会自动更新。',
          label: '新名称',
          value: oldName,
          confirmText: '重命名',
          icon: 'i-edit'
        });
        if (value === null || value === oldName) return;
        const result = await api.renamePath(target.path, value);
        if (target.type === 'dir' && expandedDirs.has(target.path)) {
          expandedDirs.delete(target.path);
          expandedDirs.add(result.path);
        }
        // 同步所有指向该路径的标签
        state.tabs.forEach((tab) => {
          if (tab.path === target.path) {
            tab.path = result.path;
            tab.name = result.name;
          }
        });
        if (state.currentFile === target.path) {
          state.currentFile = result.path;
          updateStatus();
          renderTabs();
        }
        await refreshTree();
        toast(`已重命名为：${result.name}`, 'success');
        log(`已重命名：${oldName} → ${result.name}`, 'success');
        if (result.vitepressSynced) {
          log(`已同步更新 ${result.vitepressSynced} 处 VitePress 链接，发布后站点导航保持有效。`, 'success');
        }
      } else if (action === 'delete') {
        const isCurrent = state.currentFile === target.path && state.dirty;
        const firstLine = isCurrent
          ? `「${displayNodeName(target)}」有未保存的更改，确认删除？`
          : (target.type === 'dir' ? `删除文件夹「${displayNodeName(target)}」？` : `删除文件「${displayNodeName(target)}」？`);
        const ok = await askConfirm(
          firstLine,
          '项目会被移入回收站，可以从回收站恢复。\n此操作只影响当前工作区，不会同步到 GitHub。'
        );
        if (!ok) return;
        const deleteResult = await api.deletePath(target.path);
        if (target.type === 'dir') expandedDirs.delete(target.path);
        // 关闭受影响的标签（文件或该目录下的文件）
        const affected = state.tabs.filter((tab) => tab.path === target.path
          || (target.type === 'dir' && tab.path.startsWith(target.path + '/')));
        const activeAffected = affected.some((tab) => tab.id === state.activeTabId);
        state.tabs = state.tabs.filter((tab) => !affected.includes(tab));
        if (activeAffected) {
          const next = state.tabs[0] || null;
          if (next) {
            state.activeTabId = '';
            activateTab(next.id);
          } else {
            state.activeTabId = '';
            state.currentFile = '';
            state.dirty = false;
            state.lastSavedAt = null;
            historyLocked = true;
            editor.value = '';
            history.stack = [''];
            history.index = 0;
            historyLocked = false;
            updateGutter();
            updateHighlight();
            renderPreview();
            updateStatus();
          }
        }
        renderTabs();
        await refreshTree();
        toast(`已移入回收站：${displayNodeName(target)}`, 'success');
        log(`已移入回收站：${target.path}`, 'success');
        if (deleteResult && deleteResult.vitepressSynced) {
          log(`已同步清理 ${deleteResult.vitepressSynced} 条 VitePress 侧边栏条目，发布后生效。`, 'success');
        }
      }
    } catch (err) {
      toast(err.message || '操作失败', 'error');
      log(`操作失败：${err.message}`, 'error');
    }
  }

  // 目录树拖拽移动：把节点拖到文件夹上，复用 movePath 与侧边栏同步
  let draggingNode = null;

  function bindTreeDrag() {
    tree.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.tree-node');
      if (!row) return;
      draggingNode = { path: row.dataset.path, type: row.classList.contains('dir') ? 'dir' : 'file' };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggingNode.path);
      }
      row.classList.add('dragging');
    });
    tree.addEventListener('dragend', () => {
      draggingNode = null;
      tree.querySelectorAll('.tree-node').forEach((node) => node.classList.remove('dragging', 'drop-target', 'drop-invalid'));
    });
    tree.addEventListener('dragover', (event) => {
      const row = event.target.closest('.tree-node.dir');
      if (!row || !draggingNode) return;
      event.preventDefault();
      const invalid = samePath(row.dataset.path, draggingNode.path)
        || (draggingNode.type === 'dir' && isInsideDir(row.dataset.path, draggingNode.path));
      if (event.dataTransfer) event.dataTransfer.dropEffect = invalid ? 'none' : 'move';
      tree.querySelectorAll('.tree-node.drop-target').forEach((node) => {
        if (node !== row) node.classList.remove('drop-target', 'drop-invalid');
      });
      row.classList.toggle('drop-target', true);
      row.classList.toggle('drop-invalid', invalid);
    });
    tree.addEventListener('dragleave', (event) => {
      const row = event.target.closest('.tree-node.dir');
      if (row && !row.contains(event.relatedTarget)) row.classList.remove('drop-target', 'drop-invalid');
    });
    tree.addEventListener('drop', async (event) => {
      const row = event.target.closest('.tree-node.dir');
      if (!row || !draggingNode) return;
      event.preventDefault();
      event.stopPropagation();
      const source = draggingNode;
      const destination = row.dataset.path;
      tree.querySelectorAll('.tree-node').forEach((node) => node.classList.remove('dragging', 'drop-target', 'drop-invalid'));
      draggingNode = null;
      if (samePath(source.path, destination)
        || (source.type === 'dir' && isInsideDir(destination, source.path))) {
        toast('不能把文件夹移动到它自己的子目录里', 'error');
        return;
      }
      try {
        const currentInside = !!state.currentFile && isInsideDir(state.currentFile, source.path);
        if (state.dirty && currentInside) {
          const saved = await saveFile({ silent: true, skipAuto: true });
          if (!saved) return;
        }
        const result = await api.movePath(source.path, destination);
        if (source.type === 'dir') {
          const updated = new Set();
          for (const path of expandedDirs) updated.add(remapMovedPath(path, source.path, result.path));
          expandedDirs.clear();
          updated.forEach((path) => expandedDirs.add(path));
        }
        expandedDirs.add(destination);
        state.tabs.forEach((tab) => { tab.path = remapMovedPath(tab.path, source.path, result.path); });
        if (state.currentFile) {
          const movedTo = remapMovedPath(state.currentFile, source.path, result.path);
          if (movedTo !== state.currentFile) {
            state.currentFile = movedTo;
            updateStatus();
            renderTabs();
          }
        }
        await refreshTree();
        toast(`已移动到：${displayNodeName({ path: destination })}`, 'success');
        log(`已移动：${basename(result.path)} → ${result.path}`, 'success');
        if (result.vitepressSynced) {
          log(`已同步 ${result.vitepressSynced} 处 VitePress 侧边栏条目，发布后生效。`, 'success');
        }
      } catch (err) {
        toast(err.message || '移动失败', 'error');
      }
    });
  }

  function bindContextMenu() {
    bindTreeDrag();
    tree.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const row = event.target.closest('.tree-node');
      if (!row) {
        showContextMenu(event.clientX, event.clientY, null);
        return;
      }
      showContextMenu(event.clientX, event.clientY, {
        path: row.dataset.path,
        type: row.classList.contains('dir') ? 'dir' : (row.classList.contains('image') ? 'image' : 'file'),
        name: basename(row.dataset.path)
      });
    });

    $('contextMenu').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      const target = contextTarget;
      closeContextMenu();
      handleContextAction(action, target);
    });

    document.addEventListener('mousedown', (event) => {
      if (!event.target.closest('#contextMenu')) closeContextMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeContextMenu();
    });
    window.addEventListener('blur', closeContextMenu);
    tree.addEventListener('scroll', closeContextMenu);
  }

  async function openFile(filePath, targetLine) {
    if (!filePath) return false;
    // 已在标签中打开：直接切换过去
    const existing = state.tabs.find((tab) => tab.path === filePath);
    if (existing) {
      activateTab(existing.id);
      if (targetLine && targetLine > 0) focusLine(targetLine);
      recordRecent(filePath);
      persistSession();
      return true;
    }
    try {
      // 允许工作区外的单个文件（例如“最近打开”里的文件）被读取和保存
      await api.grantPath(filePath);
      const result = await api.readFile(filePath);
      // 未保存状态保留在各自标签中，不再强制弹窗覆盖
      const tab = createTab(result.path, result.content);
      syncActiveTab();
      state.activeTabId = tab.id;
      state.currentFile = tab.path;
      state.dirty = false;
      state.lastSavedAt = null;
      bindHistory(tab);
      historyLocked = true;
      editor.value = tab.content;
      editor.setSelectionRange(0, 0);
      historyLocked = false;
      editor.scrollTop = 0;
      updateStatus();
      updateGutter();
      updateHighlight();
      renderPreview();
      renderTabs();
      refreshTree();
      if (targetLine && targetLine > 0) focusLine(targetLine);
      recordRecent(result.path);
      persistSession();
      log(`已打开：${basename(result.path)}`);
      return true;
    } catch (err) {
      toast(`打开文件失败：${err.message}`, 'error');
      log(`打开文件失败：${err.message}`, 'error');
      return false;
    }
  }

  function focusLine(line) {
    const lines = editor.value.split('\n');
    const idx = Math.max(0, Math.min(Number(line) - 1, lines.length - 1));
    let offset = 0;
    for (let i = 0; i < idx; i += 1) offset += lines[i].length + 1;
    editor.focus();
    editor.setSelectionRange(offset, offset + (lines[idx] || '').length);
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
    editor.scrollTop = Math.max(0, idx * lineHeight - editor.clientHeight / 2 + lineHeight);
    gutter.scrollTop = editor.scrollTop;
    highlightLayer.scrollTop = editor.scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;
    updateCursor();
  }

  async function openFileDialog() {
    try {
      const filePath = await api.openFileDialog();
      if (filePath) await openFile(filePath);
    } catch (err) {
      toast(err.message, 'error');
      log(err.message, 'error');
    }
  }

  // ===== 最近打开（文件 + 工作区） =====
  const RECENT_LIMIT = 15;
  const RECENT_WS_LIMIT = 10;

  function samePathKey(a, b) {
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return Boolean(norm(a)) && norm(a) === norm(b);
  }

  function getRecentFiles() {
    return Array.isArray(state.config && state.config.recentFiles) ? state.config.recentFiles.slice() : [];
  }

  function getRecentWorkspaces() {
    return Array.isArray(state.config && state.config.recentWorkspaces) ? state.config.recentWorkspaces.slice() : [];
  }

  function persistRecent(patch) {
    const files = Array.isArray(patch) ? patch : (patch && Array.isArray(patch.files) ? patch.files : getRecentFiles());
    const workspaces = patch && Array.isArray(patch.workspaces) ? patch.workspaces : getRecentWorkspaces();
    const cfg = state.config || {};
    cfg.recentFiles = files;
    cfg.recentWorkspaces = workspaces;
    state.config = cfg;
    return api.saveConfig(cfg).then((saved) => { if (saved) state.config = saved; }).catch(() => {});
  }

  function recordRecent(filePath) {
    if (!filePath) return;
    const list = getRecentFiles().filter((p) => p !== filePath);
    list.unshift(filePath);
    persistRecent({ files: list.slice(0, RECENT_LIMIT) });
  }

  function recordRecentWorkspace(workspacePath) {
    if (!workspacePath) return;
    const list = getRecentWorkspaces().filter((p) => !samePathKey(p, workspacePath));
    list.unshift(workspacePath);
    persistRecent({ workspaces: list.slice(0, RECENT_WS_LIMIT) });
  }

  function appendRecentGroup(menu, title, items, isWorkspace) {
    if (!items.length) return;
    const heading = document.createElement('div');
    heading.className = 'dropdown-group-title';
    heading.textContent = title;
    menu.appendChild(heading);
    items.forEach((itemPath) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = isWorkspace ? 'recent-item recent-workspace' : 'recent-item';
      btn.title = itemPath;
      const name = document.createElement('span');
      name.className = 'recent-name';
      if (isWorkspace) {
        name.innerHTML = '<svg class="icon recent-icon"><use href="#i-folder"></use></svg>';
        name.appendChild(document.createTextNode(basename(itemPath)));
      } else {
        name.textContent = basename(itemPath);
      }
      const path = document.createElement('span');
      path.className = 'recent-path';
      path.textContent = itemPath;
      btn.appendChild(name);
      btn.appendChild(path);
      btn.addEventListener('click', async () => {
        closeFloatingMenus();
        if (isWorkspace) {
          const ok = await openRecentWorkspace(itemPath);
          if (ok === false) persistRecent({ workspaces: getRecentWorkspaces().filter((p) => p !== itemPath) });
          return;
        }
        const ok = await openFile(itemPath);
        if (ok === false) persistRecent({ files: getRecentFiles().filter((p) => p !== itemPath) });
      });
      menu.appendChild(btn);
    });
  }

  function renderRecentMenu() {
    const menu = $('recentMenu');
    if (!menu) return;
    const files = getRecentFiles();
    const workspaces = getRecentWorkspaces();
    menu.innerHTML = '';
    if (!files.length && !workspaces.length) {
      const empty = document.createElement('div');
      empty.className = 'recent-empty';
      empty.textContent = '暂无最近打开';
      menu.appendChild(empty);
      return;
    }
    appendRecentGroup(menu, '工作区', workspaces, true);
    if (workspaces.length && files.length) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      menu.appendChild(divider);
    }
    appendRecentGroup(menu, '文件', files, false);
    const divider = document.createElement('div');
    divider.className = 'divider';
    menu.appendChild(divider);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'recent-clear';
    clear.textContent = '清空最近打开';
    clear.addEventListener('click', () => {
      persistRecent({ files: [], workspaces: [] });
      closeFloatingMenus();
      toast('已清空最近打开列表', 'success');
    });
    menu.appendChild(clear);
  }

  async function openNewFileDialog(template) {
    pendingTemplate = template || null;
    $('newFileName').value = template ? `${template.name.replace(/[\\/:*?"<>|]/g, '-')}.md` : '';
    // 默认位置：当前工作区，没有则用主目录
    let dir = newFileDir;
    if (!dir) {
      try { dir = (await api.getDefaultSaveDir()) || ''; } catch (_err) { dir = ''; }
    }
    newFileDir = dir;
    $('newFileDir').textContent = dir || '（点击选择保存位置）';
    $('newFileModal').classList.add('open');
    setTimeout(() => $('newFileName').focus(), 50);
  }

  async function chooseNewFileDir() {
    try {
      const dir = await api.chooseSaveDir(newFileDir);
      if (dir) {
        newFileDir = dir;
        $('newFileDir').textContent = dir;
      }
    } catch (err) {
      toast(`选择位置失败：${err.message}`, 'error');
    }
  }

  async function confirmNewFile() {
    const name = $('newFileName').value.trim();
    if (!name) {
      toast('请输入文件名', 'error');
      $('newFileName').focus();
      return;
    }
    if (!newFileDir) {
      toast('请选择保存位置', 'error');
      chooseNewFileDir();
      return;
    }
    const dir = newFileDir;
    $('newFileModal').classList.remove('open');
    try {
      const created = await api.createFile(dir, name);
      if (pendingTemplate) {
        await api.writeFile(created.path, pendingTemplate.content || '');
      }
      pendingTemplate = null;
      await refreshTree();
      await openFile(created.path);
      toast(`已新建：${created.name}`, 'success');
      log(`已新建：${created.path}`, 'success');
    } catch (err) {
      toast(`新建失败：${err.message}`, 'error');
      log(`新建失败：${err.message}`, 'error');
    }
  }

  function markTabSaved(tab, filePath, content) {
    if (!tab) return;
    tab.path = filePath;
    tab.name = basename(filePath);
    tab.content = content;
    tab.dirty = false;
    tab.lastSavedAt = new Date();
  }

  // 为保存的内容创建本地快照（静默失败，不影响主保存流程）
  function createSnapshot(filePath, content, label) {
    if (!filePath) return Promise.resolve(null);
    return api.saveSnapshot(filePath, content, label).catch((err) => {
      log(`创建版本快照失败：${err.message}`, 'error');
      return null;
    });
  }

  // ---------- 自动保存 ----------
  function restartAutoSaveTimer() {
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer);
      autoSaveTimer = null;
    }
    const ed = (state.config && state.config.editor) || {};
    if (!ed.autoSave) return;
    const delaySec = Math.max(5, Number(ed.autoSaveDelay) || 30);
    autoSaveTimer = setInterval(() => {
      if (!state.dirty || !state.currentFile) return;
      saveFile({ silent: true, skipAuto: true, auto: true }).then((ok) => {
        if (ok) lastAutoSaveAt = Date.now();
      });
    }, delaySec * 1000);
    log(`自动保存已开启（每 ${delaySec} 秒）`, 'success');
  }

  // ---------- 本地版本历史 ----------
  function formatSnapshotTime(stamp) {
    const d = new Date(stamp);
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }

  // 行级 LCS diff：返回按顺序排列的 same/add/del 行
  function diffLines(oldText, newText) {
    const a = String(oldText || '').replace(/\r\n?/g, '\n').split('\n');
    const b = String(newText || '').replace(/\r\n?/g, '\n').split('\n');
    const n = a.length;
    const m = b.length;
    // 大文件降级：超过上限直接整段替换显示，避免 O(n*m) 卡死
    if (n * m > 1500000) {
      return [
        ...a.map((line) => ({ type: 'del', text: line })),
        ...b.map((line) => ({ type: 'add', text: line }))
      ];
    }
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i += 1; }
      else { out.push({ type: 'add', text: b[j] }); j += 1; }
    }
    while (i < n) { out.push({ type: 'del', text: a[i] }); i += 1; }
    while (j < m) { out.push({ type: 'add', text: b[j] }); j += 1; }
    return out;
  }

  function showDiff(oldText, newText, label) {
    const modal = $('diffModal');
    $('diffDesc').textContent = label || '左侧为历史版本，右侧为当前内容。';
    const changes = diffLines(oldText, newText);
    const adds = changes.filter((c) => c.type === 'add').length;
    const dels = changes.filter((c) => c.type === 'del').length;
    if (!adds && !dels) {
      $('diffBody').innerHTML = '<div class="diff-empty">✓ 内容完全相同，没有差异</div>';
    } else {
      const frag = document.createDocumentFragment();
      changes.forEach((change) => {
        const row = document.createElement('div');
        row.className = `diff-line ${change.type}`;
        const sign = document.createElement('span');
        sign.className = 'diff-sign';
        sign.textContent = change.type === 'add' ? '+' : change.type === 'del' ? '-' : ' ';
        const text = document.createElement('span');
        text.textContent = change.text || ' ';
        row.appendChild(sign);
        row.appendChild(text);
        frag.appendChild(row);
      });
      $('diffBody').innerHTML = '';
      $('diffBody').appendChild(frag);
    }
    modal.classList.add('open');
  }

  async function openHistory() {
    $('historyModal').classList.add('open');
    await loadHistory();
  }

  async function loadHistory() {
    const list = $('historyList');
    if (!state.currentFile) {
      $('historyDesc').textContent = '当前没有已保存的文件，保存后即可生成版本历史。';
      list.innerHTML = '<div class="history-empty"><span class="empty-emoji">🕰️</span>还没有历史记录<br>先保存一次，时光机就启动啦</div>';
      return;
    }
    $('historyDesc').textContent = `「${basename(state.currentFile)}」的本地版本，每次保存自动记录，最多保留 40 个。`;
    list.innerHTML = '<div class="history-empty">加载中…</div>';
    try {
      const items = await api.listSnapshots(state.currentFile, 40);
      if (!items || !items.length) {
        list.innerHTML = '<div class="history-empty"><span class="empty-emoji">🕰️</span>还没有历史版本<br>保存一次文档就会出现在这里</div>';
        return;
      }
      list.innerHTML = '';
      items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = `history-item${index === 0 ? ' latest' : ''}`;
        const size = item.size ? ` · ${(item.size / 1024).toFixed(1)} KB` : '';
        row.innerHTML = `<span class="history-time">${escapeHtml(formatSnapshotTime(item.stamp))}${index === 0 ? ' <span class="history-tag">最新</span>' : ''}</span>`
          + `<span class="history-meta">${escapeHtml(item.label || '自动保存')}${size}</span>`
          + `<button class="btn history-diff" type="button" style="margin-right:8px">对比</button>`
          + `<button class="btn history-restore" type="button">恢复</button>`;
        row.querySelector('.history-diff').addEventListener('click', async () => {
          try {
            const snapshot = await api.readSnapshot(item.id);
            syncActiveTab();
            showDiff(snapshot.content, editor.value,
              `对比：${formatSnapshotTime(item.stamp)} 的快照 → 当前内容（＋新增 / －删除）`);
          } catch (err) {
            toast(`对比失败：${err.message}`, 'error');
          }
        });
        row.querySelector('.history-restore').addEventListener('click', async () => {
          try {
            const snapshot = await api.readSnapshot(item.id);
            const ok = await askConfirm('恢复版本', `恢复到 ${formatSnapshotTime(item.stamp)} 的版本？\n当前未保存的更改会丢失，恢复后请手动保存。`);
            if (!ok) return;
            syncActiveTab();
            editor.value = snapshot.content;
            resetHistory(snapshot.content);
            markDirty();
            $('historyModal').classList.remove('open');
            toast('已恢复该版本，请手动保存', 'success');
            log(`已恢复版本：${formatSnapshotTime(item.stamp)}`, 'success');
          } catch (err) {
            toast(`恢复失败：${err.message}`, 'error');
          }
        });
        list.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<div class="history-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
  }

  async function saveFile(options = {}) {
    if (!state.currentFile) return saveAs(options);
    const savingPath = state.currentFile;
    const savingContent = editor.value;
    try {
      await api.writeFile(savingPath, savingContent);
      api.deleteDraftByPath(savingPath).catch(() => {});
      state.dirty = false;
      state.lastSavedAt = new Date();
      markTabSaved(activeTab(), savingPath, savingContent);
      createSnapshot(savingPath, savingContent, options.auto ? '自动保存' : '手动保存');
      updateStatus();
      renderPreview();
      renderTabs();
      refreshTree();
      if (!options.silent) toast('已妥帖保存 ✅', 'success');
      log(`已保存：${basename(savingPath)}`, 'success');
      if (!options.skipAuto && shouldAutoPublish()) {
        await publish({ fromSave: true });
      }
      scheduleScanPublishMarks(600);
      return true;
    } catch (err) {
      toast(`保存失败：${err.message}`, 'error');
      log(`保存失败：${err.message}`, 'error');
      return false;
    }
  }

  async function saveAs(options = {}) {
    try {
      const filePath = await api.saveAsDialog(state.currentFile);
      if (!filePath) return false;
      await api.writeFile(filePath, editor.value);
      state.currentFile = filePath;
      state.dirty = false;
      state.lastSavedAt = new Date();
      markTabSaved(activeTab(), filePath, editor.value);
      createSnapshot(filePath, editor.value, '另存为');
      recordRecent(filePath);
      persistSession();
      updateStatus();
      renderPreview();
      renderTabs();
      refreshTree();
      toast('另存为完成，新文件已就位 🎉', 'success');
      log(`另存为：${filePath}`, 'success');
      if (!options.skipAuto && shouldAutoPublish()) {
        await publish({ fromSave: true });
      }
      scheduleScanPublishMarks(600);
      return true;
    } catch (err) {
      toast(`另存为失败：${err.message}`, 'error');
      log(`另存为失败：${err.message}`, 'error');
      return false;
    }
  }

  // VitePress 侧边栏配置必须与文档一起发布，否则线上目录不会更新
  function isSidebarConfigChange(change) {
    const p = String((change && change.repoPath) || '').replace(/\\/g, '/');
    return /\.vitepress\/config\.(mts|ts|mjs|js)$/i.test(p) && change.status !== 'deleted';
  }

  function toBatchSelection(change) {
    return {
      repoPath: change.repoPath,
      relative: change.relative,
      status: change.status,
      filePath: change.filePath,
      asset: !!change.asset
    };
  }

  async function publish(options = {}) {
    if (!options.fromSave) {
      const saved = await saveFile({ skipAuto: true });
      if (!saved) return;
    }
    if (!state.currentFile) {
      toast('没有可发布的文件', 'error');
      return;
    }
    toggleLog(true);
    setPublishStatus('busy', '发布中…');
    try {
      if (options.fromSave) {
        // 保存后自动发布：扫描时同步站点目录，并把配置变更放进同一次提交
        const scanned = await api.scanPublishChanges({ syncSidebar: true });
        const changes = scanned.changes || [];
        const prefix = String((state.config && state.config.github && state.config.github.pathPrefix) || '')
          .replace(/^\/+|\/+$/g, '');
        const rel = state.workspace
          ? String(state.currentFile).slice(String(state.workspace).length)
          : basename(state.currentFile);
        const currentRepoPath = [prefix, rel.replace(/\\/g, '/').replace(/^\/+/, '')].filter(Boolean).join('/');
        const selected = changes.filter((c) => c.repoPath === currentRepoPath || isSidebarConfigChange(c));
        if (!selected.length) {
          setPublishStatus('ok', '已是最新');
          toast('已是最新版本，无需发布 🌿', 'success');
          return;
        }
        const result = await api.publishBatch(selected.map(toBatchSelection));
        setPublishStatus('ok', '已发布');
        toast(`已发布 ${result.count} 个文件，构建已启动 🚀`, 'success');
        log(`自动发布成功：${result.count} 个文件（含站点目录同步）。提交：${result.commitUrl || result.commitSha}`, 'success');
      } else {
        const result = await api.publish(state.currentFile, editor.value);
        setPublishStatus('ok', '已发布');
        toast('发布成功，构建已启动 🚀', 'success');
        log(`发布成功：${result.repoPath || basename(state.currentFile)}`, 'success');
        if (result.commitUrl) log(`提交地址：${result.commitUrl}`);
      }
      scheduleScanPublishMarks(400);
    } catch (err) {
      setPublishStatus('error', '发布失败');
      toast(`发布失败：${cleanError(err)}`, 'error');
      log(`发布失败：${cleanError(err)}`, 'error');
    }
  }

  // 从当前 Git 仓库拉取最新内容；保留本地未保存修改，刷新已打开且无改动的文档
  async function pullFromRepository() {
    if (!state.workspace) {
      toast('请先打开工作区，再执行拉取', 'error');
      return;
    }
    setPublishStatus('busy', '拉取中…');
    try {
      const result = await api.gitPull();
      let reloaded = 0;
      for (const tab of state.tabs) {
        if (!tab.path || tab.dirty) continue;
        try {
          const file = await api.readFile(tab.path);
          const content = String(file && file.content || '');
          if (content === tab.content) continue;
          createSnapshot(tab.path, content, 'git pull');
          tab.content = content;
          tab.history = { stack: [content], index: 0 };
          markTabSaved(tab, tab.path, content);
          reloaded += 1;
        } catch (_) { /* 单个文件读取失败不阻断拉取 */ }
      }
      const active = activeTab();
      if (active) {
        bindHistory(active);
        resetHistory(active.content);
        editor.value = active.content;
        editor.setSelectionRange(0, 0);
        updateHighlight();
        renderPreview();
        updateStatus();
      }
      await refreshTree();
      scheduleScanPublishMarks(300);
      setPublishStatus('ok', '已拉取');
      const tail = String(result.output || '').split('\n').filter(Boolean).slice(-2).join(' · ') || '已是最新';
      const backedUp = Array.isArray(result.backedUp) ? result.backedUp : [];
      const backupNote = backedUp.length ? `；${backedUp.length} 个冲突文件已备份，需手动合并` : '';
      toast(`已拉取最新内容${reloaded ? `，刷新 ${reloaded} 个文档` : ''}${backupNote}`, 'success');
      log(`git pull 完成（${result.remote || 'origin'}）：${tail}`, 'success');
      if (backedUp.length) {
        log(`与远端同名的未跟踪文件已移到备份目录：${result.backupDir}`, 'warn');
        backedUp.forEach((item) => log(`备份：${item.from}`, 'warn'));
      }
    } catch (err) {
      setPublishStatus('error', '拉取失败');
      toast(`拉取失败：${cleanError(err)}`, 'error');
      log(`git pull 失败：${cleanError(err)}`, 'error');
    }
  }

  // ---------- 发布预览：先看改了哪些文件，再选择性发布 ----------
  let publishChanges = [];
  let publishBusy = false;

  const PUB_STATUS = {
    modified: { label: '修改', cls: 'mod' },
    added: { label: '新增', cls: 'add' },
    deleted: { label: '删除', cls: 'del' }
  };

  async function openPublishDialog() {
    if (publishBusy) return;
    // 先把当前活动文件保存，确保扫描到的是最新内容（跳过自动发布，避免重复提交）
    if (state.currentFile && state.dirty) {
      const saved = await saveFile({ skipAuto: true, silent: true });
      if (!saved) return;
    }
    $('publishModal').classList.add('open');
    $('publishDesc').textContent = '正在对比本地与线上文件…';
    $('publishSummary').innerHTML = '';
    $('publishList').innerHTML = '<div class="history-empty">正在扫描变更，请稍候…</div>';
    $('btnPublishConfirm').disabled = true;
    publishChanges = [];

    try {
      const cfg = state.config && state.config.github;
      if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
        throw new Error('尚未配置 GitHub 发布参数，请先在「发布 → GitHub 发布设置」中填写。');
      }
      // 打开发布预览时同步 VitePress 侧边栏，新增文档会一并列入本次提交
      const result = await api.scanPublishChanges({ syncSidebar: true });
      publishChanges = result.changes || [];
      // 复用本次扫描结果更新目录树标识，避免再发一次网络请求
      applyPublishChangesToMarks(result);
      refreshTree();
      const counts = {
        modified: publishChanges.filter((c) => c.status === 'modified').length,
        added: publishChanges.filter((c) => c.status === 'added').length,
        deleted: publishChanges.filter((c) => c.status === 'deleted').length
      };
      $('publishDesc').textContent = `${result.owner}/${result.repo} @ ${result.branch}${result.prefix ? ' · ' + result.prefix : ''}`;
      $('publishSummary').innerHTML =
        `<span class="pub-stat"><b>${counts.modified}</b> 修改</span>` +
        `<span class="pub-stat"><b>${counts.added}</b> 新增</span>` +
        `<span class="pub-stat"><b>${counts.deleted}</b> 删除</span>` +
        `<span class="pub-stat muted">共扫描 ${result.totalLocal} 个本地 / ${result.totalRemote} 个线上文件</span>` +
        (result.truncated ? '<span class="pub-stat warn">远程文件树不完整，结果可能有遗漏</span>' : '');

      // 后台做链接体检，把失效引用数量放到发布预览顶部，点击可查看明细
      api.checkLinks().then((linkResult) => {
        const count = linkResult && linkResult.issues ? linkResult.issues.length : 0;
        const stat = document.createElement('button');
        stat.type = 'button';
        stat.className = `pub-stat link-check-stat${count ? ' warn' : ''}`;
        stat.innerHTML = count ? `<b>${count}</b> 处失效链接 · 查看` : '✓ 链接正常';
        stat.addEventListener('click', () => {
          $('publishModal').classList.remove('open');
          openLinksCheck();
        });
        $('publishSummary').appendChild(stat);
      }).catch(() => {});

      if (!publishChanges.length) {
        $('publishList').innerHTML = '<div class="history-empty">本地文件与线上完全一致，没有需要发布的改动。✓</div>';
        $('pubCheckAll').checked = false;
        updatePublishSelection();
        return;
      }

      renderPublishList();
      $('pubCheckAll').checked = true;
      updatePublishSelection();
      log(`发布预览：发现 ${publishChanges.length} 个待发布文件。`, 'info');
    } catch (err) {
      $('publishDesc').textContent = '扫描失败';
      $('publishList').innerHTML = `<div class="history-empty">扫描失败：${escapeHtml(err.message)}</div>`;
      toast(`扫描变更失败：${err.message}`, 'error');
      log(`扫描发布变更失败：${err.message}`, 'error');
    }
  }

  function renderPublishList() {
    const list = $('publishList');
    list.innerHTML = publishChanges.map((change, index) => {
      const meta = PUB_STATUS[change.status] || PUB_STATUS.modified;
      const kb = change.size ? ` · ${(change.size / 1024).toFixed(1)} KB` : '';
      const required = isSidebarConfigChange(change);
      return `<div class="pub-item" data-pub-index="${index}">
        <div class="pub-item-main">
          <label class="pub-check"><input type="checkbox" class="pub-cb" data-pub-index="${index}" ${required ? 'checked disabled' : 'checked'} /></label>
          <span class="pub-status ${meta.cls}">${meta.label}</span>
          ${required ? '<span class="pub-required" title="VitePress 站点目录配置会随本次发布一起提交">目录同步</span>' : ''}
          <span class="pub-path" title="${escapeHtml(change.repoPath)}">${escapeHtml(change.repoPath)}</span>
          <span class="pub-size">${kb}</span>
          <button class="pub-toggle" data-pub-toggle="${index}" title="查看具体改动">改动 ▾</button>
          <button class="pub-revert" data-pub-revert="${index}" title="撤销该文件的本地改动，恢复为线上版本">撤销</button>
        </div>
        <div class="pub-diff" data-pub-diff="${index}" hidden><div class="pub-diff-loading">点击展开以加载对比…</div></div>
      </div>`;
    }).join('');

    list.querySelectorAll('.pub-cb').forEach((cb) => {
      cb.addEventListener('change', updatePublishSelection);
    });
    list.querySelectorAll('[data-pub-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => togglePublishDiff(Number(btn.dataset.pubToggle), btn));
    });
    list.querySelectorAll('[data-pub-revert]').forEach((btn) => {
      btn.addEventListener('click', () => revertPublishChange(Number(btn.dataset.pubRevert)));
    });
  }

  // 撤销单个文件的本地改动：恢复成线上版本，覆盖/删除前主进程已存快照
  async function revertPublishChange(index) {
    const change = publishChanges[index];
    if (!change) return;
    const actionText = change.status === 'added' ? '删除本地新增文件' : '用线上版本覆盖本地文件';
    const ok = await askConfirm(
      '撤销改动',
      `确定要撤销以下文件的本地改动吗？\n\n${change.repoPath}\n\n将${actionText}（当前内容会先存入本地版本历史，可随时找回）。\n此文件会从待发布列表移除。`
    );
    if (!ok) return;
    const btn = $('publishList').querySelector(`[data-pub-revert="${index}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '撤销中'; }
    try {
      const result = await api.revertPublishChange(change);
      // 若该文件正在编辑器打开且无未保存改动，刷新为线上内容
      if (result && result.filePath && result.content != null) {
        const tab = state.tabs.find((t) => t.path && t.path.toLowerCase() === String(result.filePath).toLowerCase());
        if (tab && tab.id === state.activeTabId && !state.dirty) {
          editor.value = result.content;
          state.dirty = false;
          renderPreview();
          updateGutter();
          updateHighlight();
          updateStatus();
        }
      }
      publishChanges.splice(index, 1);
      renderPublishList();
      $('pubCheckAll').checked = publishChanges.length > 0;
      updatePublishSelection();
      // 同步目录树标识（移除被撤销项）
      applyPublishChangesToMarks({ changes: publishChanges, prefix: (state.config && state.config.github && state.config.github.pathPrefix) || '' });
      refreshTree();
      toast(change.status === 'added' ? '已删除新增文件（已移入回收站）' : '已恢复为线上版本', 'success');
      log(`已撤销改动：${change.repoPath}`, 'success');
    } catch (err) {
      toast(`撤销失败：${err.message}`, 'error');
      log(`撤销改动失败：${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '撤销'; }
    }
  }

  function updatePublishSelection() {
    const checked = $('publishList').querySelectorAll('.pub-cb:checked').length;
    $('pubSelectedCount').textContent = `已选 ${checked} 个`;
    $('btnPublishConfirm').disabled = checked === 0 || publishBusy;
    $('btnPublishConfirm').textContent = checked ? `发布选中的 ${checked} 个文件` : '发布选中文件';
    const all = $('publishList').querySelectorAll('.pub-cb').length;
    $('pubCheckAll').checked = all > 0 && checked === all;
  }

  async function togglePublishDiff(index, button) {
    const diffBox = $('publishList').querySelector(`[data-pub-diff="${index}"]`);
    if (!diffBox) return;
    if (!diffBox.hidden) {
      diffBox.hidden = true;
      button.textContent = '改动 ▾';
      return;
    }
    diffBox.hidden = false;
    button.textContent = '收起 ▴';
    if (diffBox.dataset.loaded === '1') return;
    diffBox.innerHTML = '<div class="pub-diff-loading">正在加载线上原文并生成对比…</div>';
    try {
      const change = publishChanges[index];
      const diff = await api.getPublishDiff(change);
      const rows = diff.lines.map((line) => {
        if (line.type === 'gap') return '<div class="pub-diff-gap">⋯ 省略未变更内容 ⋯</div>';
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
        return `<div class="pub-diff-line ${line.type}"><span class="pub-diff-sign">${sign}</span><span class="pub-diff-text">${escapeHtml(line.text)}</span></div>`;
      }).join('');
      const head = `<div class="pub-diff-head">新增 ${diff.additions} 行 · 删除 ${diff.deletions} 行${diff.truncated ? ' · 内容过大已省略' : ''}</div>`;
      diffBox.innerHTML = head + (rows || '<div class="pub-diff-gap">无逐行差异</div>');
      diffBox.dataset.loaded = '1';
    } catch (err) {
      diffBox.innerHTML = `<div class="pub-diff-loading">加载对比失败：${escapeHtml(err.message)}</div>`;
    }
  }

  async function confirmPublishBatch() {
    if (publishBusy) return;
    const cbList = $('publishList').querySelectorAll('.pub-cb');
    const selectedIndices = new Set();
    cbList.forEach((cb) => {
      if (cb.checked) selectedIndices.add(Number(cb.dataset.pubIndex));
    });
    // 站点目录配置即使被禁用勾选也必须随发布提交，否则线上侧边栏不会更新
    publishChanges.forEach((change, index) => {
      if (isSidebarConfigChange(change)) selectedIndices.add(index);
    });
    const selected = [...selectedIndices].sort((a, b) => a - b)
      .map((index) => publishChanges[index])
      .filter(Boolean);
    if (!selected.length) {
      toast('请先勾选要发布的文件', 'error');
      return;
    }

    publishBusy = true;
    $('btnPublishConfirm').disabled = true;
    $('btnPublishConfirm').textContent = `正在发布 ${selected.length} 个文件…`;
    toggleLog(true);
    setPublishStatus('busy', '发布中…');
    try {
      const result = await api.publishBatch(selected.map((c) => ({
        repoPath: c.repoPath,
        relative: c.relative,
        status: c.status,
        filePath: c.filePath
      })));
      $('publishModal').classList.remove('open');
      setPublishStatus('ok', '已发布');
      toast(`已发布 ${result.count} 个文件，GitHub Actions 已触发`, 'success');
      log(`批量发布成功：${result.count} 个文件。提交：${result.commitUrl || result.commitSha}`, 'success');
      scheduleScanPublishMarks(400);
    } catch (err) {
      setPublishStatus('error', '发布失败');
      toast(`发布失败：${cleanError(err)}`, 'error');
      log(`批量发布失败：${cleanError(err)}`, 'error');
      $('btnPublishConfirm').disabled = false;
      $('btnPublishConfirm').textContent = `发布选中的 ${selected.length} 个文件`;
    } finally {
      publishBusy = false;
    }
  }

  // ---------- 查找与替换 ----------
  function buildFindRegex() {
    const raw = $('findInput').value;
    if (!raw) return null;
    const useRegex = $('findRegex').checked;
    const caseSensitive = $('findCase').checked;
    const wholeWord = $('findWord').checked;
    let pattern;
    try {
      pattern = useRegex ? raw : raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } catch (_err) {
      return null;
    }
    if (wholeWord && !useRegex) pattern = `\\b${pattern}\\b`;
    let flags = caseSensitive ? 'g' : 'gi';
    try {
      return new RegExp(pattern, flags);
    } catch (err) {
      toast(`正则表达式无效：${err.message}`, 'error');
      return null;
    }
  }

  function openFindDialog() {
    // 用当前选区预填查找词，体验更符合直觉
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (selected && !selected.includes('\n')) $('findInput').value = selected;
    $('replaceInput').value = '';
    $('findModal').classList.add('open');
    setTimeout(() => {
      $('findInput').focus();
      $('findInput').select();
    }, 50);
  }

  function findMatch(fromIndex, backwards) {
    const re = buildFindRegex();
    if (!re) {
      if ($('findInput').value) toast('查找内容无效', 'error');
      else $('findInput').focus();
      return null;
    }
    const value = editor.value;
    if (backwards) {
      // 向前查找：收集所有匹配，取起始位置小于 fromIndex 的最后一个
      const matches = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(value)) !== null) {
        matches.push({ start: m.index, length: m[0].length, groups: m });
        if (m[0].length === 0) re.lastIndex += 1;
        if (matches.length > 100000) break;
      }
      if (!matches.length) return { none: true };
      const prev = [...matches].reverse().find((x) => x.start < fromIndex - 1);
      const found = prev || matches[matches.length - 1];
      return { start: found.start, length: found.length, wrapped: !prev, count: matches.length };
    }
    re.lastIndex = fromIndex;
    const m = re.exec(value);
    if (m) return { start: m.index, length: m[0].length, wrapped: false };
    re.lastIndex = 0;
    const first = re.exec(value);
    if (first) return { start: first.index, length: first[0].length, wrapped: true };
    return { none: true };
  }

  function doFind(fromIndex, backwards = false) {
    const result = findMatch(fromIndex, backwards);
    if (!result) return;
    if (result.none) {
      toast('未找到匹配内容', 'error');
      return;
    }
    if (result.wrapped) toast(backwards ? '已到文档末尾，从头继续查找' : '已到文档末尾，从头继续查找', 'info');
    selectMatch(result.start, result.length, false);
  }

  function selectMatch(index, length, closeModal = true) {
    if (closeModal) $('findModal').classList.remove('open');
    editor.focus();
    editor.setSelectionRange(index, index + length);
    const line = editor.value.slice(0, index).split('\n').length;
    editor.scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(editor).lineHeight || '28'));
    gutter.scrollTop = editor.scrollTop;
    highlightLayer.scrollTop = editor.scrollTop;
    updateCursor();
  }

  function doReplace() {
    const re = buildFindRegex();
    if (!re) {
      if ($('findInput').value) toast('查找内容无效', 'error');
      else $('findInput').focus();
      return;
    }
    const value = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    // 命中当前选区（首个匹配恰好等于选区）则替换它
    const checkRe = new RegExp(re.source, flags);
    checkRe.lastIndex = start;
    const m = checkRe.exec(value);
    if (!m || m.index !== start || m.index + m[0].length !== end) {
      toast('请先选中一个匹配项，或点“查找下一个”', 'error');
      return;
    }
    const replacement = $('replaceInput').value;
    const expanded = m[0].replace(new RegExp(re.source, flags.replace('g', '')), replacement);
    const next = value.slice(0, start) + expanded + value.slice(end);
    editor.value = next;
    editor.setSelectionRange(start, start + expanded.length);
    markDirty();
    toast('已替换 1 处', 'success');
    // 自动定位到下一个匹配
    setTimeout(() => doFind(start + expanded.length), 0);
  }

  function doReplaceAll() {
    const re = buildFindRegex();
    if (!re) {
      if ($('findInput').value) toast('查找内容无效', 'error');
      else $('findInput').focus();
      return;
    }
    const value = editor.value;
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const globalRe = new RegExp(re.source, flags);
    const replacement = $('replaceInput').value;
    let count = 0;
    const next = value.replace(globalRe, (...args) => {
      count += 1;
      if ($('findRegex').checked) {
        // 支持 $1 / $& 等替换模式
        return replacement.replace(/\$(\d+|\&)/g, (tok, key) => {
          if (key === '&') return args[0];
          const idx = Number(key);
          return args[idx] !== undefined ? args[idx] : tok;
        });
      }
      return replacement;
    });
    if (!count) {
      toast('未找到匹配内容', 'error');
      return;
    }
    const pos = Math.min(editor.selectionStart, next.length);
    editor.value = next;
    editor.setSelectionRange(pos, pos);
    markDirty();
    toast(`已替换 ${count} 处`, 'success');
    $('findModal').classList.remove('open');
  }

  // 预览中点击任务复选框，回写源文件对应的 - [ ] / - [x]
  function toggleTaskInSource(taskId, checked) {
    const lineIndex = window.MarkdownRender.getTaskLine(taskId);
    if (typeof lineIndex !== 'number' || lineIndex < 0) return;
    const value = editor.value;
    const lines = value.split('\n');
    if (lineIndex >= lines.length) return;
    const updated = lines[lineIndex].replace(/^(\s*[-*+]\s+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
    if (updated === lines[lineIndex]) return;
    lines[lineIndex] = updated;
    const scroll = editor.scrollTop;
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    editor.value = lines.join('\n');
    editor.scrollTop = scroll;
    editor.setSelectionRange(selStart, selEnd);
    markDirty();
  }

  // 列表回车续行：返回 true 表示已自行处理
  function handleListEnter() {
    const value = editor.value;
    const selStart = editor.selectionStart;
    const lineStart = value.lastIndexOf('\n', selStart - 1) + 1;
    let lineEnd = value.indexOf('\n', selStart);
    if (lineEnd === -1) lineEnd = value.length;
    const lineText = value.slice(lineStart, lineEnd);
    const match = lineText.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
    if (!match) return false;

    const indent = match[1];
    const marker = match[2];
    const taskPart = match[3];
    const content = match[4];
    const afterCursor = value.slice(selStart, lineEnd);

    // 空列表项：回车退出列表（清除该行标记）
    if (!content.trim()) {
      editor.setRangeText(indent, lineStart, lineEnd, 'end');
      markDirty();
      updateCursor();
      return true;
    }

    let nextMarker = marker;
    if (/^\d/.test(marker)) {
      const num = parseInt(marker, 10);
      const sep = marker.slice(String(num).length);
      nextMarker = `${num + 1}${sep}`;
    }
    // 已勾选的任务项回车不再续任务标记
    const nextTask = taskPart ? (taskPart[1].toLowerCase() === 'x' ? '' : '- [ ] ') : '';
    const insert = `\n${indent}${nextMarker} ${nextTask}`;
    editor.setRangeText(insert + afterCursor, selStart, lineEnd, 'end');
    // 光标放到新行内容起始处
    const pos = selStart + insert.length;
    editor.setSelectionRange(pos, pos);
    markDirty();
    updateCursor();
    return true;
  }

  // 把图片绝对路径转成相对当前文档目录的 Markdown 引用（正斜杠、带 ../）
  function imageMarkdownPath(absPath) {
    const file = state.currentFile || '';
    const dir = dirnameOf(file) || state.workspace || '';
    const base = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = String(absPath).replace(/\\/g, '/');
    const parts = target.split('/');
    const rel = parts.slice(0, -1).join('/').toLowerCase();
    let common = 0;
    while (common < rel.split('/').length && common < base.split('/').length
      && rel.split('/')[common] === base.split('/')[common]) common += 1;
    const ups = base.split('/').length - common;
    const tail = parts.slice(common);
    return [...Array(ups).fill('..'), ...tail].join('/');
  }

  async function insertImageAtCursor(image, range) {
    if (!image) return;
    const snippet = `![图片](${imageMarkdownPath(image.path)})`;
    const start = range ? range.start : editor.selectionStart;
    const end = range ? range.end : editor.selectionEnd;
    editor.setRangeText(snippet, start, end, 'end');
    editor.focus();
    markDirty();
    schedulePreview();
    toast(`已插入图片：${basename(image.path)}`, 'success');
    log(`已插入图片：${image.path}`, 'success');
  }

  async function pasteImageFromClipboard(range) {
    try {
      const image = await api.pasteImage();
      if (image) await insertImageAtCursor(image, range);
      return true;
    } catch (err) {
      return false;
    }
  }

  function readClipboardImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取剪贴板图片失败'));
      reader.readAsDataURL(file);
    });
  }

  async function pasteImageFileFromClipboard(file, range) {
    try {
      const dataUrl = await readClipboardImageFile(file);
      if (!/^data:image\//i.test(dataUrl)) throw new Error('不是图片文件');
      const image = await api.pasteImageFile({ name: file.name || 'pasted-image', dataUrl });
      if (image) await insertImageAtCursor(image, range);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function chooseAndInsertImage() {
    try {
      const image = await api.chooseImage();
      if (image) await insertImageAtCursor(image);
    } catch (err) {
      toast(err.message || '插入图片失败', 'error');
    }
  }

  function wrapSelection(before, after, placeholder) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end) || placeholder;
    editor.setRangeText(before + selected + after, start, end, 'select');
    editor.selectionStart = start + before.length;
    editor.selectionEnd = start + before.length + selected.length;
    editor.focus();
    markDirty();
  }

  function prefixLines(prefixFn) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const transformed = block.split('\n').map((line, index) => prefixFn(line, index)).join('\n');
    editor.setRangeText(transformed, lineStart, lineEnd, 'select');
    editor.focus();
    markDirty();
  }

  function insertBlock(text) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end);
    const block = `\n${text.replace('{selection}', selected) || ''}\n`;
    editor.setRangeText(block, start, end, 'end');
    editor.focus();
    markDirty();
  }

  function cleanLine(line) {
    return line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
  }

  function applyStyle(style) {
    if (style === 'p') {
      prefixLines(cleanLine);
      return;
    }
    if (/^h[1-6]$/.test(style)) {
      const level = Number(style.slice(1));
      prefixLines((line) => `${'#'.repeat(level)} ${cleanLine(line)}`);
      return;
    }
    if (style === 'quote') {
      prefixLines((line) => `> ${cleanLine(line)}`);
      return;
    }
    if (style === 'ul') {
      prefixLines((line) => `- ${cleanLine(line)}`);
      return;
    }
    if (style === 'ol') {
      prefixLines((line, index) => `${index + 1}. ${cleanLine(line)}`);
      return;
    }
    if (style === 'task') {
      prefixLines((line) => `- [ ] ${cleanLine(line)}`);
      return;
    }
    if (style === 'codeblock') {
      insertBlock('```\n{selection}\n```');
    }
  }

  function closeFloatingMenus(except) {
    document.querySelectorAll('.menu-group').forEach((group) => {
      if (group !== except) group.classList.remove('open');
    });
    document.querySelectorAll('.custom-select').forEach((select) => {
      if (select !== except) select.classList.remove('open');
    });
    const picker = $('tablePicker');
    if (picker && picker !== except) picker.classList.remove('open');
    ['colorPicker', 'highlightPicker', 'alignPicker'].forEach((id) => {
      const el = $(id);
      if (el && el !== except) el.classList.remove('open');
    });
    const recentSubmenu = $('recentSubmenu');
    if (recentSubmenu && recentSubmenu !== except) recentSubmenu.classList.remove('open');
    document.querySelectorAll('.dropdown.submenu-open').forEach((dropdown) => {
      if (!except || !dropdown.contains(except)) dropdown.classList.remove('submenu-open');
    });
    const statusMoodWrap = $('statusMoodWrap');
    if (statusMoodWrap && statusMoodWrap !== except) statusMoodWrap.classList.remove('open');
    const appMenu = $('appMenu');
    const exceptInsideAppMenu = except && appMenu && appMenu.contains(except);
    if (appMenu && appMenu !== except && !exceptInsideAppMenu) appMenu.classList.remove('open');
    const toolOverflow = $('toolbarOverflow');
    if (toolOverflow && toolOverflow !== except) toolOverflow.classList.remove('open');
  }

  // 工具栏溢出收纳：窗口变窄时把放不下的工具依次移进「更多」菜单，变宽自动还原。
  // 移动的是原 DOM 节点，因此按钮上已绑定的事件、复合控件的下拉都完整保留。
  let toolbarSlots = [];
  let toolbarReflowing = false;
  function reflowToolbarOverflow() {
    const bar = $('toolbar');
    const root = $('toolbarOverflow');
    const menu = $('toolOverflowMenu');
    if (!bar || !root || !menu) return;
    if (toolbarReflowing) return;
    toolbarReflowing = true;

    // 1) 全部还原到各自的原始位置
    toolbarSlots.forEach((slot) => {
      if (slot.el.parentNode !== slot.home) {
        const ref = slot.home.children[slot.originalIndex] || null;
        slot.home.insertBefore(slot.el, ref);
      }
    });
    root.classList.remove('has-overflow', 'open');
    while (menu.firstChild) menu.removeChild(menu.firstChild);

    // 2) 预留「更多」按钮宽度后，判断是否溢出
    root.classList.add('has-overflow');
    const excess = () => bar.scrollWidth - bar.clientWidth;
    if (excess() <= 1) {
      root.classList.remove('has-overflow');
      toolbarReflowing = false;
      return;
    }

    // 3) 从右往左收纳（视图/主题/设置等 tail 按钮最后收），直到不再溢出
    for (const slot of toolbarSlots) {
      if (excess() <= 1) break;
      if (slot.el.parentNode !== slot.home) continue;
      // 隐藏分组里的槽位不参与收纳
      if (slot.el.offsetParent === null) continue;
      menu.appendChild(slot.el);
    }
    if (!menu.firstChild) root.classList.remove('has-overflow');
    toolbarReflowing = false;
  }

  function initToolbarOverflow() {
    const bar = $('toolbar');
    const root = $('toolbarOverflow');
    const menu = $('toolOverflowMenu');
    const moreBtn = $('btnToolOverflow');
    if (!bar || !root || !menu || !moreBtn) return;

    // 槽位 = 三个 tool-group 的直接子元素 + tail 的直接子元素
    const containers = Array.from(bar.querySelectorAll('.tool-group, .toolbar-tail'));
    const tail = bar.querySelector('.toolbar-tail');
    toolbarSlots = [];
    containers.forEach((container) => {
      Array.from(container.children).forEach((child, index) => {
        // 固定按钮（如发布直达）永不收进「更多工具」
        if (child.classList && child.classList.contains('tool-pinned')) return;
        toolbarSlots.push({ el: child, home: container, originalIndex: index });
      });
    });
    // 收纳顺序：先收普通工具组（从右往左），最后才收 tail（视图/主题/设置优先保留）
    toolbarSlots.sort((a, b) => {
      const aTail = a.home === tail ? 1 : 0;
      const bTail = b.home === tail ? 1 : 0;
      if (aTail !== bTail) return aTail - bTail;
      return b.originalIndex - a.originalIndex;
    });

    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = root.classList.contains('open');
      closeFloatingMenus(root);
      root.classList.toggle('open', !wasOpen);
    });
    // 点击普通工具按钮后自动收起菜单；复合控件的下拉保持打开
    menu.addEventListener('click', (event) => {
      const btn = event.target.closest('.tool-btn');
      if (btn && !btn.classList.contains('custom-select-trigger') && !btn.classList.contains('color-trigger')) {
        setTimeout(() => root.classList.remove('open'), 0);
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => reflowToolbarOverflow()).observe(bar);
    } else {
      window.addEventListener('resize', reflowToolbarOverflow);
    }
    // 首屏布局完成后收纳一次
    requestAnimationFrame(() => requestAnimationFrame(reflowToolbarOverflow));
  }

  function setupCustomSelect(id, onSelect) {
    const root = $(id);
    if (!root) return;
    root.querySelector('.custom-select-trigger').addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = root.classList.contains('open');
      closeFloatingMenus(root);
      root.classList.toggle('open', !wasOpen);
    });
    root.querySelectorAll('.custom-select-menu button[data-value]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        setCustomSelectValue(id, button.dataset.value);
        root.classList.remove('open');
        onSelect(button.dataset.value);
      });
    });
  }

  function paintTableGrid(rows, cols) {
    document.querySelectorAll('.table-cell').forEach((cell) => {
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      cell.classList.toggle('active', row <= rows && col <= cols);
    });
    $('tableGridLabel').textContent = rows && cols ? `${cols} 列 × ${rows} 行` : '移动鼠标选择行列';
  }

  function insertTable(rows, cols) {
    const lines = [
      `| ${Array.from({ length: cols }, (_unused, index) => `列 ${index + 1}`).join(' | ')} |`,
      `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
    ];
    for (let row = 1; row < rows; row += 1) {
      lines.push(`| ${Array.from({ length: cols }, () => '  ').join(' | ')} |`);
    }
    insertBlock(lines.join('\n'));
    toast(`已插入 ${cols} 列 × ${rows} 行表格`, 'success');
  }

  function bindTablePicker() {
    const grid = $('tableGrid');
    for (let row = 1; row <= 8; row += 1) {
      for (let col = 1; col <= 8; col += 1) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'table-cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.title = `${col} 列 × ${row} 行`;
        grid.appendChild(cell);
      }
    }
    grid.addEventListener('mouseover', (event) => {
      const cell = event.target.closest('.table-cell');
      if (cell) paintTableGrid(Number(cell.dataset.row), Number(cell.dataset.col));
    });
    grid.addEventListener('click', (event) => {
      const cell = event.target.closest('.table-cell');
      if (!cell) return;
      const rows = Number(cell.dataset.row);
      const cols = Number(cell.dataset.col);
      $('tablePicker').classList.remove('open');
      insertTable(rows, cols);
    });
    $('tablePickerBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      const picker = $('tablePicker');
      const wasOpen = picker.classList.contains('open');
      closeFloatingMenus(picker);
      picker.classList.toggle('open', !wasOpen);
      if (!wasOpen) paintTableGrid(0, 0);
    });
  }

  // 语雀风格调色板：灰度行 + 10 色相 × 5 级明度矩阵
  const YQ_GRAYSCALE = ['#000000', '#4A4A4A', '#6B6B6B', '#8C8C8C', '#ADADAD', '#CFCFCF', '#E0E0E0', '#EBEBEB', '#F5F5F5', '#FFFFFF'];
  const YQ_MATRIX = [
    ['#FF4D4F', '#FF7A45', '#FFA940', '#FFC53D', '#A0D911', '#52C41A', '#13C2C2', '#1890FF', '#722ED1', '#EB2F96'],
    ['#FFA39E', '#FFBB96', '#FFD591', '#FFE58F', '#D3F261', '#B7EB8F', '#87E8DE', '#91D5FF', '#D3ADF7', '#FFADD2'],
    ['#FFCCC7', '#FFD8BF', '#FFE7BA', '#FFF1B8', '#E8F79B', '#D9F7BE', '#B5F5EC', '#D6E4FF', '#EEDCFF', '#FFD6E7'],
    ['#CF1322', '#D4380D', '#D46B08', '#D4B106', '#5B8C00', '#389E0D', '#08979C', '#096DD9', '#531DAB', '#C41D7F'],
    ['#820014', '#7E2507', '#874300', '#8C6D00', '#3F6600', '#237804', '#00474F', '#003A8C', '#391085', '#780037']
  ];
  const YQ_GRADIENTS = ['#1890FF,#722ED1', '#722ED1,#EB2F96', '#EB2F96,#FA8C16', '#FA541C,#FAAD14'];
  const RECENT_KEY = 'mdstudio.recentColors';

  function loadRecent(kind) {
    try {
      const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
      return Array.isArray(all[kind]) ? all[kind].slice(0, 8) : [];
    } catch (_err) {
      return [];
    }
  }

  function saveRecent(kind, color) {
    const all = {};
    try { Object.assign(all, JSON.parse(localStorage.getItem(RECENT_KEY) || '{}')); } catch (_err) { /* ignore */ }
    const list = (Array.isArray(all[kind]) ? all[kind] : []).filter((c) => c !== color);
    list.unshift(color);
    all[kind] = list.slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(all)); } catch (_err) { /* ignore */ }
  }

  function makeSwatch(color, className, apply) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = className;
    swatch.style.background = color;
    swatch.title = color;
    swatch.dataset.color = color;
    swatch.addEventListener('click', (event) => {
      event.stopPropagation();
      apply(color);
    });
    return swatch;
  }

  function buildPalette(kind, apply) {
    const grayBox = $(`${kind}Grayscale`);
    const matrixBox = $(`${kind}Swatches`);
    [grayBox, matrixBox].forEach((box) => { if (box) box.innerHTML = ''; });
    YQ_GRAYSCALE.forEach((color) => grayBox.appendChild(makeSwatch(color, 'yq-swatch', apply)));
    YQ_MATRIX.forEach((row) => row.forEach((color) => matrixBox.appendChild(makeSwatch(color, 'yq-swatch', apply))));

    const recentBox = $(`${kind}Recent`);
    if (recentBox) {
      const recent = loadRecent(kind);
      recentBox.innerHTML = '';
      if (!recent.length) {
        recentBox.innerHTML = '<span class="yq-empty">暂无</span>';
      } else {
        recent.forEach((color) => recentBox.appendChild(makeSwatch(color, 'yq-recent-swatch', apply)));
      }
    }
  }

  function markCurrent(pickerId, container, color) {
    container.querySelectorAll('.yq-swatch, .yq-recent-swatch').forEach((s) => {
      s.classList.toggle('current', s.dataset.color && s.dataset.color.toLowerCase() === String(color).toLowerCase());
    });
  }

  function bindColorPickers() {
    // 文字颜色
    const textApply = (color) => {
      $('colorCustom').value = color;
      $('colorIndicator').style.background = color;
      saveRecent('text', color);
      buildPalette('color', textApply);
      markCurrent('colorPicker', $('colorPopover'), color);
      $('colorPicker').classList.remove('open');
      wrapSelection(`<span style="color:${color}">`, '</span>', '彩色文字');
    };
    buildPalette('color', textApply);
    YQ_GRADIENTS.forEach((pair) => {
      const grad = makeSwatch(`linear-gradient(135deg, ${pair})`, 'yq-gradient', () => {
        $('colorPicker').classList.remove('open');
        wrapSelection(`<span style="background-image:linear-gradient(135deg,${pair});color:transparent;-webkit-background-clip:text;background-clip:text;font-weight:600">`, '</span>', '渐变文字');
      });
      grad.title = `渐变 ${pair}`;
      $('colorGradients').appendChild(grad);
    });
    $('colorDefault').addEventListener('click', (event) => { event.stopPropagation(); textApply('#1f2937'); });
    $('colorPickerBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      const picker = $('colorPicker');
      const wasOpen = picker.classList.contains('open');
      closeFloatingMenus(picker);
      picker.classList.toggle('open', !wasOpen);
    });
    $('colorMore').addEventListener('click', (event) => { event.stopPropagation(); $('colorCustom').click(); });
    $('colorCustom').addEventListener('click', (event) => event.stopPropagation());
    $('colorCustom').addEventListener('change', (event) => textApply(event.target.value));

    // 背景高亮
    const hlApply = (color) => {
      $('highlightCustom').value = color;
      $('hlLetter').style.background = color;
      saveRecent('highlight', color);
      buildPalette('highlight', hlApply);
      markCurrent('highlightPicker', $('highlightPopover'), color);
      $('highlightPicker').classList.remove('open');
      wrapSelection(`<mark style="background-color:${color}">`, '</mark>', '高亮文字');
    };
    buildPalette('highlight', hlApply);
    $('highlightDefault').addEventListener('click', (event) => { event.stopPropagation(); hlApply('#fde047'); });
    $('highlightPickerBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      const picker = $('highlightPicker');
      const wasOpen = picker.classList.contains('open');
      closeFloatingMenus(picker);
      picker.classList.toggle('open', !wasOpen);
    });
    $('highlightMore').addEventListener('click', (event) => { event.stopPropagation(); $('highlightCustom').click(); });
    $('highlightCustom').addEventListener('click', (event) => event.stopPropagation());
    $('highlightCustom').addEventListener('change', (event) => hlApply(event.target.value));

    // 按钮色条从最近使用色恢复
    const recentText = loadRecent('text');
    if (recentText.length) {
      $('colorIndicator').style.background = recentText[0];
      $('colorCustom').value = recentText[0];
    }
    const recentHl = loadRecent('highlight');
    if (recentHl.length) {
      $('hlLetter').style.background = recentHl[0];
      $('highlightCustom').value = recentHl[0];
    }

    // 对齐方式（语雀式）
    $('alignPickerBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      const picker = $('alignPicker');
      const wasOpen = picker.classList.contains('open');
      closeFloatingMenus(picker);
      picker.classList.toggle('open', !wasOpen);
    });
    document.querySelectorAll('.align-opt').forEach((opt) => {
      opt.addEventListener('click', (event) => {
        event.stopPropagation();
        document.querySelectorAll('.align-opt').forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        $('alignPicker').classList.remove('open');
        const align = opt.dataset.align;
        // 对当前行（或选中的多行）应用对齐：写入通用内联 HTML，兼容剥离旧的 {align:} 语法
        prefixLines((line) => {
          const cleaned = line
            .replace(/^\s*\{align:(?:left|center|right|justify)\|/, '').replace(/\}\s*$/, '')
            .replace(/^\s*<div\b[^>]*>/i, '').replace(/<\/div>\s*$/i, '');
          return `<div style="text-align:${align}">${cleaned}</div>`;
        });
      });
    });
  }

  async function copySelection() {
    editor.focus();
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (!selected) {
      toast('请先选中要复制的内容', 'error');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(selected);
      } else {
        throw new Error('clipboard API 不可用');
      }
      toast('已复制到剪贴板', 'success');
    } catch (err) {
      // 回退方案：临时 textarea + execCommand
      const temp = document.createElement('textarea');
      temp.value = selected;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_err) { ok = false; }
      document.body.removeChild(temp);
      editor.focus();
      toast(ok ? '已复制到剪贴板' : `复制失败：${err.message}`, ok ? 'success' : 'error');
    }
  }

  // ---------- 缩进 ----------
  const INDENT_UNIT = '  ';
  function indentLines(delta) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const transformed = block.split('\n').map((line) => {
      if (delta > 0) return INDENT_UNIT + line;
      return line.replace(/^( {1,2}|\t)/, '');
    }).join('\n');
    editor.setRangeText(transformed, lineStart, lineEnd, 'select');
    editor.focus();
    markDirty();
  }

  // ---------- 清除格式 / 格式刷 的标记处理 ----------
  // 去掉行内所有 Markdown / VitePress 扩展标记，只保留纯文本
  function stripAllFormat(text) {
    let out = String(text ?? '');
    // 方案2：先剥离内联 HTML 标签（span/mark/u/div 等），保留标签之间的正文
    out = out.replace(/<\/?(?:span|mark|u|div|br|strong|em|b|i|sub|sup|small)\b[^>]*>/gi, '');
    // 兼容旧版自研扩展语法
    out = out.replace(/\{color:#[0-9a-fA-F]{3,8}\|([\s\S]*?)\}/g, '$1');
    out = out.replace(/\{bg:#[0-9a-fA-F]{3,8}\|([\s\S]*?)\}/g, '$1');
    out = out.replace(/\{grad:[^|]+\|([\s\S]*?)\}/g, '$1');
    out = out.replace(/\{align:(?:left|center|right|justify)\|([\s\S]*?)\}/g, '$1');
    out = out.replace(/==#[0-9a-fA-F]{3,8}\|([\s\S]*?)==/g, '$1');
    out = out.replace(/!?\[([\s\S]*?)\]\([^)]*\)/g, '$1');
    out = out.replace(/\*\*([\s\S]*?)\*\*/g, '$1');
    out = out.replace(/~~([\s\S]*?)~~/g, '$1');
    out = out.replace(/\+\+([\s\S]*?)\+\+/g, '$1');
    out = out.replace(/==([\s\S]*?)==/g, '$1');
    out = out.replace(/`([\s\S]*?)`/g, '$1');
    out = out.replace(/\*([\s\S]*?)\*/g, '$1');
    return out;
  }

  // 尝试剥离一层行内格式，返回 { before, after, inner } 或 null
  function stripInlineLayer(text) {
    let m;
    // 方案2：内联 HTML 包裹层（span/mark/u/div 等），提取开/闭标签作为格式骨架
    if ((m = text.match(/^(<(?:span|mark|u|div|strong|em|b|i|sub|sup|small)\b[^>]*>)([\s\S]*)(<\/(?:span|mark|u|div|strong|em|b|i|sub|sup|small)>)$/i))) {
      return { before: m[1], after: m[3], inner: m[2] };
    }
    // 兼容旧版自研扩展语法
    if ((m = text.match(/^==(#[0-9a-fA-F]{3,8})\|([\s\S]*)==$/))) {
      return { before: `==${m[1]}|`, after: '==', inner: m[2] };
    }
    if ((m = text.match(/^\{color:(#[0-9a-fA-F]{3,8})\|([\s\S]*)\}$/))) {
      return { before: `{color:${m[1]}|`, after: '}', inner: m[2] };
    }
    if ((m = text.match(/^\{bg:(#[0-9a-fA-F]{3,8})\|([\s\S]*)\}$/))) {
      return { before: `{bg:${m[1]}|`, after: '}', inner: m[2] };
    }
    if ((m = text.match(/^\{grad:([^|]+)\|([\s\S]*)\}$/))) {
      return { before: `{grad:${m[1]}|`, after: '}', inner: m[2] };
    }
    if ((m = text.match(/^\{align:(left|center|right|justify)\|([\s\S]*)\}$/))) {
      return { before: `{align:${m[1]}|`, after: '}', inner: m[2] };
    }
    if ((m = text.match(/^!\[([\s\S]*)\]\(([^)]*)\)$/))) {
      return { before: '![', after: `](${m[2]})`, inner: m[1] };
    }
    if ((m = text.match(/^\[([\s\S]*)\]\(([^)]*)\)$/))) {
      return { before: '[', after: `](${m[2]})`, inner: m[1] };
    }
    const symmetric = ['**', '~~', '++', '==', '*', '`'];
    for (const sym of symmetric) {
      if (text.length > sym.length * 2 && text.startsWith(sym) && text.endsWith(sym)) {
        return { before: sym, after: sym, inner: text.slice(sym.length, -sym.length) };
      }
    }
    return null;
  }

  function detectBlockPrefix(line) {
    const m = String(line).match(/^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+))/);
    return m ? m[1] : '';
  }

  // 从源文本提取格式骨架：块前缀 + 由外到内的行内包裹对
  function extractFormat(source) {
    const blockPrefix = detectBlockPrefix(source);
    let cur = source.trim();
    // 先去掉块前缀（如 "- "、"## "），否则行内标记被挡在最前面无法剥离
    const leadingBlock = detectBlockPrefix(cur);
    if (leadingBlock) cur = cur.slice(leadingBlock.length).trim();
    const wrappers = [];
    let layer;
    while ((layer = stripInlineLayer(cur))) {
      wrappers.push({ before: layer.before, after: layer.after });
      cur = layer.inner.trim();
      if (wrappers.length >= 10) break;
    }
    return { wrappers, blockPrefix };
  }

  function clearFormat() {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const transformed = block.split('\n').map((line) => stripAllFormat(cleanLine(line))).join('\n');
    editor.setRangeText(transformed, lineStart, lineEnd, 'select');
    editor.focus();
    markDirty();
    toast('已清除所选内容的格式', 'success');
  }

  function cancelFormatPainter() {
    state.formatPainter = null;
    document.body.classList.remove('painter-mode');
    const btn = $('btnFormatPainter');
    if (btn) btn.classList.remove('format-painter-active');
  }

  function captureFormat() {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    let source = editor.value.slice(start, end);
    if (!source.trim()) {
      const value = editor.value;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      let lineEnd = value.indexOf('\n', start);
      if (lineEnd === -1) lineEnd = value.length;
      source = value.slice(lineStart, lineEnd);
    }
    const fmt = extractFormat(source);
    if (!fmt.wrappers.length && !fmt.blockPrefix) {
      toast('请先选中一段带格式的文本（如 **粗体**、列表项、彩色文字等）', 'error');
      return;
    }
    state.formatPainter = { wrappers: fmt.wrappers, blockPrefix: fmt.blockPrefix };
    document.body.classList.add('painter-mode');
    const btn = $('btnFormatPainter');
    if (btn) btn.classList.add('format-painter-active');
    // 折叠选区，避免刚复制的格式立刻被应用到同一段文本
    editor.setSelectionRange(end, end);
    toast('已复制格式，请选中要套用的文本；按 Esc 取消', 'success');
  }

  function toggleFormatPainter() {
    if (state.formatPainter) {
      cancelFormatPainter();
      toast('已取消格式刷', 'success');
    } else {
      captureFormat();
    }
  }

  // 格式刷激活时，用户选中目标文本后套用格式。返回是否实际应用。
  function applyFormatPainter() {
    const painter = state.formatPainter;
    if (!painter) return false;
    let start = editor.selectionStart;
    let end = editor.selectionEnd;
    if (start === end) return false;

    // 1) 行内格式套用到选区（先清除旧格式，再由内到外包裹）
    const selected = editor.value.slice(start, end);
    let replacement = stripAllFormat(selected);
    for (let i = painter.wrappers.length - 1; i >= 0; i--) {
      const w = painter.wrappers[i];
      replacement = w.before + replacement + w.after;
    }
    editor.setRangeText(replacement, start, end, 'select');
    start = editor.selectionStart;
    end = editor.selectionEnd;

    // 2) 块前缀：从后往前给选区涉及的每一行加前缀（若尚无）
    if (painter.blockPrefix) {
      const value = editor.value;
      const firstLineStart = value.lastIndexOf('\n', start - 1) + 1;
      let lastLineEnd = value.indexOf('\n', end);
      if (lastLineEnd === -1) lastLineEnd = value.length;
      const positions = [firstLineStart];
      for (let p = firstLineStart; p < lastLineEnd; p++) {
        if (value[p] === '\n') positions.push(p + 1);
      }
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        const curLineEnd = editor.value.indexOf('\n', pos);
        const endPos = curLineEnd === -1 ? editor.value.length : curLineEnd;
        const lineText = editor.value.slice(pos, endPos);
        if (!detectBlockPrefix(lineText)) {
          editor.setRangeText(painter.blockPrefix, pos, pos, 'end');
        }
      }
    }
    editor.focus();
    markDirty();
    cancelFormatPainter();
    toast('格式已应用', 'success');
    return true;
  }

  function applyFormat(command) {
    switch (command) {
      case 'new': return openNewFileDialog();
      case 'undo': return undo();
      case 'redo': return redo();
      case 'copy': return copySelection();
      case 'formatPainter': return toggleFormatPainter();
      case 'clearFormat': return clearFormat();
      case 'indentIn': return indentLines(1);
      case 'indentOut': return indentLines(-1);
      case 'bold': return wrapSelection('**', '**', '粗体文字');
      case 'italic': return wrapSelection('*', '*', '斜体文字');
      case 'strike': return wrapSelection('~~', '~~', '删除线');
      case 'underline': return wrapSelection('<u>', '</u>', '下划线');
      case 'color': return wrapSelection('<span style="color:#e11d48">', '</span>', '强调文字');
      case 'highlight': return wrapSelection('<mark>', '</mark>', '高亮文字');
      case 'align': return wrapSelection('<div style="text-align:center">', '</div>', '居中文字');
      case 'ul': return prefixLines((line) => `- ${line.replace(/^\s*[-*+]\s+/, '')}`);
      case 'ol': return prefixLines((line, index) => `${index + 1}. ${line.replace(/^\s*\d+[.)]\s+/, '')}`);
      case 'task': return prefixLines((line) => `- [ ] ${line.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')}`);
      case 'quote': return prefixLines((line) => `> ${line.replace(/^\s*>\s?/, '')}`);
      case 'link': return wrapSelection('[', '](https://example.com)', '链接文字');
      case 'image': return chooseAndInsertImage();
      case 'code': return wrapSelection('`', '`', '代码');
      case 'codeblock': return insertBlock('```js\n{selection}\n```');
      case 'superscript': return wrapSelection('^', '^', '上标');
      case 'subscript': return wrapSelection('~', '~', '下标');
      case 'inlineMath': return wrapSelection('$', '$', 'E=mc^2');
      case 'mathBlock': return insertBlock('$$\n{selection}\n$$');
      case 'table': return insertTable(2, 3);
      case 'hr': return insertBlock('---');
      case 'settings': return openSettings();
      case 'publish': return openPublishDialog();
      default: return undefined;
    }
  }

  function renderPlaygroundList() {
    const list = $('playgroundList');
    list.innerHTML = '';
    PLAYGROUND[playgroundTab].forEach((item, index) => {
      const card = document.createElement('div');
      card.className = `playground-item${index === playgroundSelected ? ' active' : ''}`;
      card.dataset.index = String(index);
      card.innerHTML = `<span class="item-title">${escapeHtml(item.title)}</span><span class="item-desc">${escapeHtml(item.desc)}</span><div class="item-actions"><button type="button" class="item-insert" data-index="${index}">插入</button></div>`;
      list.appendChild(card);
    });
  }

  function showPlaygroundExample(index) {
    const item = PLAYGROUND[playgroundTab][index];
    if (!item) return;
    playgroundSelected = index;
    renderPlaygroundList();
    $('playgroundPreview').innerHTML = window.MarkdownRender.render(item.syntax);
    $('playgroundPreview').scrollTop = 0;
  }

  function openPlayground() {
    playgroundTab = 'markdown';
    document.querySelectorAll('.playground-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === playgroundTab);
    });
    $('playgroundModal').classList.add('open');
    showPlaygroundExample(0);
  }

  function bindPlayground() {
    document.querySelectorAll('.playground-tabs button').forEach((button) => {
      button.addEventListener('click', () => {
        playgroundTab = button.dataset.tab;
        document.querySelectorAll('.playground-tabs button').forEach((candidate) => {
          candidate.classList.toggle('active', candidate === button);
        });
        showPlaygroundExample(0);
      });
    });

    $('playgroundList').addEventListener('click', (event) => {
      const insertButton = event.target.closest('.item-insert');
      if (insertButton) {
        const item = PLAYGROUND[playgroundTab][Number(insertButton.dataset.index)];
        if (item) {
          insertBlock(item.syntax);
          toast(`已插入「${item.title}」示例`, 'success');
        }
        return;
      }
      const card = event.target.closest('.playground-item');
      if (card) showPlaygroundExample(Number(card.dataset.index));
    });

    $('btnPlaygroundClose').addEventListener('click', () => $('playgroundModal').classList.remove('open'));
    $('playgroundModal').addEventListener('click', (event) => {
      if (event.target === $('playgroundModal')) $('playgroundModal').classList.remove('open');
    });
  }

  async function openSettings() {
    // GitHub 配置按当前工作区隔离：不同文件夹可对应不同仓库
    let gh = {};
    try {
      gh = (await api.getGithubConfig()) || {};
      if (state.config) state.config.github = gh;
    } catch (err) {
      gh = (state.config && state.config.github) || {};
    }
    const ed = (state.config && state.config.editor) || {};
    if ($('settingsWsHint')) {
      $('settingsWsHint').textContent = state.workspace
        ? `当前工作区：${state.workspace}（发布配置仅对该文件夹生效）`
        : '当前工作区：未选择（请先打开文件夹，再配置对应仓库）';
      $('settingsWsHint').classList.toggle('warn', !state.workspace);
    }
    $('autoSaveEnabled').checked = Boolean(ed.autoSave);
    $('autoSaveDelay').value = Number(ed.autoSaveDelay) || 30;
    // 老配置只有 enabled 字段：迁移到 autoPublish，避免升级后行为突变
    $('ghAutoPublish').checked = gh.autoPublish !== undefined ? Boolean(gh.autoPublish) : Boolean(gh.enabled);
    $('ghConvertSyntax').checked = gh.convertSyntax !== false;
    $('ghOwner').value = gh.owner || '';
    $('ghRepo').value = gh.repo || '';
    $('ghBranch').value = gh.branch || 'main';
    $('ghPrefix').value = gh.pathPrefix || 'docs';
    $('ghToken').value = gh.token || '';
    $('ghWorkflow').value = gh.workflow || 'deploy.yml';
    $('ghWorkflowRef').value = gh.workflowRef || '';
    $('ghMessage').value = gh.commitTemplate || 'docs: update {file}';
    const upd = state.config && state.config.update ? state.config.update : {};
    if ($('updateRepo')) $('updateRepo').value = upd.repo || '';
    if ($('updateEnabled')) $('updateEnabled').checked = upd.enabled !== false;
    clearGithubCheck();
    $('settingsModal').classList.add('open');
  }

  function readGithubForm() {
    return {
      // 保留 enabled 兼容旧配置；手动发布不再读取它
      enabled: true,
      autoPublish: $('ghAutoPublish').checked,
      convertSyntax: $('ghConvertSyntax').checked,
      owner: $('ghOwner').value.trim(),
      repo: $('ghRepo').value.trim(),
      branch: $('ghBranch').value.trim() || 'main',
      pathPrefix: $('ghPrefix').value.trim(),
      token: $('ghToken').value.trim(),
      workflow: $('ghWorkflow').value.trim(),
      workflowRef: $('ghWorkflowRef').value.trim(),
      commitTemplate: $('ghMessage').value.trim() || 'docs: update {file}'
    };
  }

  function clearGithubCheck() {
    const status = $('ghCheckStatus');
    const result = $('ghCheckResult');
    if (status) { status.textContent = ''; status.className = 'gh-check-status'; }
    if (result) { result.hidden = true; result.innerHTML = ''; }
  }

  async function checkGithubConnection() {
    const status = $('ghCheckStatus');
    const result = $('ghCheckResult');
    const gh = readGithubForm();
    if (!gh.owner || !gh.repo || !gh.token) {
      if (status) { status.textContent = '请先填写 Owner、仓库名和 Token'; status.className = 'gh-check-status fail'; }
      return;
    }
    const btn = $('btnCheckGithub');
    if (btn) btn.disabled = true;
    if (status) { status.textContent = '正在检测…'; status.className = 'gh-check-status'; }
    if (result) { result.hidden = true; result.innerHTML = ''; }
    try {
      const res = await api.checkGithubAccess(gh);
      if (result) {
        result.innerHTML = (res.checks || []).map((c) => (
          `<div class="gh-check-line ${c.ok ? 'ok' : 'fail'}"><span class="gh-check-mark">${c.ok ? '✓' : '✕'}</span>`
          + `<span><strong>${escapeHtml(c.label)}</strong>${c.detail ? ` · <span class="gh-check-detail">${escapeHtml(c.detail)}</span>` : ''}</span></div>`
        )).join('');
        result.hidden = false;
      }
      if (status) {
        status.textContent = res.ok ? '连接正常，可以发布' : '发现问题，请查看下方详情';
        status.className = `gh-check-status ${res.ok ? 'ok' : 'fail'}`;
      }
    } catch (err) {
      if (status) { status.textContent = `检测失败：${err.message}`; status.className = 'gh-check-status fail'; }
      if (result) { result.innerHTML = `<div class="gh-check-line fail"><span class="gh-check-mark">✕</span><span class="gh-check-detail">${escapeHtml(err.message)}</span></div>`; result.hidden = false; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveSettings() {
    const editorSettings = {
      ...((state.config && state.config.editor) || {}),
      autoSave: $('autoSaveEnabled').checked,
      autoSaveDelay: Math.max(5, Math.min(600, Number($('autoSaveDelay').value) || 30))
    };
    const githubSettings = readGithubForm();
    try {
      // 编辑偏好与更新配置全局保存；GitHub 配置按当前工作区单独保存
      const updateSettings = {
        repo: $('updateRepo') ? $('updateRepo').value.trim() : ((state.config && state.config.update && state.config.update.repo) || ''),
        enabled: $('updateEnabled') ? $('updateEnabled').checked : true
      };
      state.config = await api.saveConfig({ ...state.config, editor: editorSettings, update: updateSettings });
      await api.saveGithubConfig(githubSettings);
      if (state.config) state.config.github = { ...githubSettings, autoPublish: githubSettings.autoPublish };
      restartAutoSaveTimer();
      $('settingsModal').classList.remove('open');
      toast(state.workspace ? '设置已保存（发布配置仅对当前工作区生效）' : '设置已保存', 'success');
      log('编辑偏好与发布设置已更新', 'success');
    } catch (err) {
      toast(`保存设置失败：${err.message}`, 'error');
      log(`保存设置失败：${err.message}`, 'error');
    }
  }

  async function exportPdf() {
    if (!state.currentFile && !editor.value.trim()) {
      toast('当前没有可导出的内容', 'error');
      return;
    }
    // 确保预览是最新内容
    renderPreview();
    const title = state.currentFile ? basename(state.currentFile).replace(/\.[^.]+$/, '') : '未命名文档';
    try {
      toast('正在生成 PDF…', 'info');
      const result = await api.exportPdf({
        html: preview.innerHTML,
        title,
        fontSize: state.fontSize,
        docTitle: title
      });
      if (!result || result.canceled) return;
      toast(`PDF 已导出（${Math.max(1, Math.round((result.size || 0) / 1024))} KB）`, 'success');
      log(`已导出 PDF：${result.filePath}`, 'success');
    } catch (err) {
      toast(`导出 PDF 失败：${err.message}`, 'error');
      log(`导出 PDF 失败：${err.message}`, 'error');
    }
  }

  let searchTimer = null;
  let searchToken = 0;

  function openGlobalSearch() {
    if (!state.workspace) {
      toast('请先选择工作区文件夹', 'error');
      return;
    }
    if (state.sidebarCollapsed) toggleSidebar(false);
    setSideTab('tree');
    $('searchPanel').classList.add('open');
    document.body.classList.add('search-active');
    const input = $('globalSearchInput');
    input.focus();
    input.select();
    if (input.value.trim()) runGlobalSearch();
  }

  function closeGlobalSearch() {
    $('searchPanel').classList.remove('open');
    document.body.classList.remove('search-active');
  }

  function runGlobalSearch() {
    const keyword = $('globalSearchInput').value.trim();
    const meta = $('searchMeta');
    const results = $('searchResults');
    if (!keyword) {
      meta.textContent = '';
      results.innerHTML = '<div class="search-empty">输入关键词，搜索工作区内所有 Markdown 文档<br>支持跨文件、区分大小写可选</div>';
      return;
    }
    meta.textContent = '正在搜索…';
    const token = ++searchToken;
    const options = {
      limit: 300,
      regex: !!($('searchRegex') && $('searchRegex').checked),
      caseSensitive: !!($('searchCase') && $('searchCase').checked)
    };
    api.searchDocuments(keyword, options).then((hits) => {
      if (token !== searchToken) return;
      lastSearchHits = hits || [];
      renderSearchResults(lastSearchHits, keyword);
    }).catch((err) => {
      if (token !== searchToken) return;
      meta.textContent = '搜索失败';
      results.innerHTML = `<div class="search-empty">${escapeHtml(err.message)}</div>`;
    });
  }

  function renderSearchResults(hits, keyword) {
    const meta = $('searchMeta');
    const results = $('searchResults');
    if (!hits.length) {
      meta.textContent = '未找到匹配';
      results.innerHTML = `<div class="search-empty">没有找到包含「${escapeHtml(keyword)}」的内容</div>`;
      return;
    }
    const groupByDir = !!($('searchGroup') && $('searchGroup').checked);
    const groups = new Map();
    hits.forEach((hit) => {
      const key = groupByDir ? (hit.dir || '/') : hit.path;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(hit);
    });
    const fileCount = new Set(hits.map((hit) => hit.path)).size;
    meta.textContent = `${hits.length} 处匹配 · ${fileCount} 个文件`;
    const frag = document.createDocumentFragment();
    groups.forEach((items, groupKey) => {
      const group = document.createElement('div');
      group.className = 'search-group';
      const head = document.createElement('div');
      head.className = 'search-group-head';
      const label = groupByDir ? groupKey : items[0].name;
      const rel = groupByDir ? '' : items[0].relative;
      head.innerHTML = `<svg class="icon" style="width:13px;height:13px;vertical-align:-2px"><use href="#i-file"></use></svg><span>${escapeHtml(label)}</span><span class="group-rel">${escapeHtml(rel)}</span><span class="count">${items.length}</span>`;
      group.appendChild(head);
      items.forEach((hit) => {
        const btn = document.createElement('button');
        btn.className = 'search-hit';
        btn.type = 'button';
        btn.title = `${escapeHtml(hit.relative)} · 第 ${hit.line} 行`;
        const context = hit.context && hit.context !== hit.text
          ? `<span class="search-hit-context">${escapeHtml(hit.context)}</span>` : '';
        const fileName = groupByDir ? `<span class="search-hit-context">${escapeHtml(hit.relative)}:${hit.line}</span>` : '';
        btn.innerHTML = `<span class="hit-line">${hit.line}</span>${highlightMatch(hit.text, keyword)}${fileName}${context}`;
        btn.addEventListener('click', () => {
          openFile(hit.path, hit.line).catch((err) => toast(`打开文件失败：${err.message}`, 'error'));
        });
        group.appendChild(btn);
      });
      frag.appendChild(group);
    });
    results.innerHTML = '';
    results.appendChild(frag);
  }

  function highlightMatch(text, keyword) {
    const safe = escapeHtml(text);
    const lower = text.toLowerCase();
    const needle = keyword.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx < 0) return safe;
    return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + keyword.length)) + '</mark>' + escapeHtml(text.slice(idx + keyword.length));
  }

  async function handleAction(action) {
    if (action.startsWith('insert:')) return insertSnippet(action.slice(7));
    if (action === 'tools:checkLinks') return openLinksCheck();
    if (action === 'tools:commandPalette') return openCommandPalette();
    if (action === 'tools:writingStats') return openWritingStats();
    if (action === 'publish:check') return openPublishReport();
    if (action === 'view:graph') return openGraph();
    if (action === 'file:newFromTemplate') return openTemplatePicker();
    if (action === 'app:checkUpdate') return checkForUpdate();
    switch (action) {
      case 'workspace:choose': return chooseWorkspace();
      case 'file:new': return openNewFileDialog();
      case 'file:open': return openFileDialog();
      case 'file:save': return saveFile({});
      case 'file:saveAs': return saveAs({});
      case 'file:exportPdf': return exportPdf();
      case 'view:syntaxHighlight':
        state.syntaxHighlight = !state.syntaxHighlight;
        applySyntaxHighlight();
        saveEditorConfig({ syntaxHighlight: state.syntaxHighlight });
        toast(state.syntaxHighlight ? '已开启源码语法着色' : '已关闭源码语法着色', 'success');
        return;
      case 'edit:undo': return applyFormat('undo');
      case 'edit:redo': return applyFormat('redo');
      case 'edit:find': return openFindDialog();
      case 'edit:replace':
        openFindDialog();
        setTimeout(() => $('replaceInput').focus(), 80);
        return;
      case 'edit:search': return openGlobalSearch();
      case 'format:indentIn': return indentLines(1);
      case 'format:indentOut': return indentLines(-1);
      case 'format:painter': return toggleFormatPainter();
      case 'format:clear': return clearFormat();
      case 'format:superscript': return applyFormat('superscript');
      case 'format:subscript': return applyFormat('subscript');
      case 'format:inlineMath': return applyFormat('inlineMath');
      case 'format:mathBlock': return applyFormat('mathBlock');
      case 'view:scrollSync': {
        const cfg = state.config.editor;
        const next = cfg.scrollSync === false;
        cfg.scrollSync = next;
        saveEditorConfig({ scrollSync: next });
        toast(next ? '已开启编辑/预览滚动同步' : '已关闭滚动同步', 'success');
        return;
      }
      case 'view:zoomIn':
        state.fontSize = Math.min(28, state.fontSize + 2);
        applyFontSize();
        return saveFontSize();
      case 'view:zoomOut':
        state.fontSize = Math.max(11, state.fontSize - 2);
        applyFontSize();
        return saveFontSize();
      case 'view:lineHeightUp':
        state.lineHeight = nextLineHeight(1);
        applyLineHeight();
        return saveLineHeight();
      case 'view:lineHeightDown':
        state.lineHeight = nextLineHeight(-1);
        applyLineHeight();
        return saveLineHeight();
      case 'view:log': return toggleLog();
      case 'view:sidebar': return toggleSidebar();
      case 'view:playground': return openPlayground();
      case 'mood:auto':
      case 'mood:morning':
      case 'mood:day':
      case 'mood:dusk':
      case 'mood:night': return setMood(action.slice(5));
      case 'publish:now': return openPublishDialog();
      case 'publish:pull': return pullFromRepository();
      case 'publish:settings': return openSettings();
      default: return undefined;
    }
  }

  function saveFontSize() {
    if (!state.config) return Promise.resolve();
    return api.saveConfig({
      ...state.config,
      editor: { ...state.config.editor, fontSize: state.fontSize }
    }).then((cfg) => { state.config = cfg; }).catch(() => {});
  }

  function bindEvents() {
    // 窗口失焦/关闭前把当前会话立即落盘，避免延迟写入丢失
    window.addEventListener('blur', () => { syncActiveTab(); persistSession(true); });

    // 图片预览弹窗
    const imageViewer = $('imageViewer');
    if (imageViewer) {
      const closeBtn = $('btnCloseImageViewer');
      if (closeBtn) closeBtn.addEventListener('click', closeImagePreview);
      const nameBtn = $('btnCopyImageName');
      if (nameBtn) nameBtn.addEventListener('click', () => {
        const name = $('imageViewerName').textContent;
        copyToClipboard(name, '已复制文件名');
      });
      const pathBtn = $('btnCopyImagePath');
      if (pathBtn) pathBtn.addEventListener('click', () => {
        if (state.imagePreviewPath) copyToClipboard(relativeToWorkspace(state.imagePreviewPath), '已复制相对路径');
      });
      imageViewer.addEventListener('click', (event) => {
        if (event.target === imageViewer) closeImagePreview();
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeImagePreview();
      closeFloatingMenus();
    });

    // 本页目录：标题栏按钮切换显隐（VitePress 风格固定侧栏）
    const btnToggleOutline = $('btnTogglePreviewOutline');
    if (btnToggleOutline) {
      btnToggleOutline.addEventListener('click', () => {
        const hidden = document.body.classList.contains('preview-outline-hidden');
        setPreviewOutlineVisible(hidden, true);
      });
    }
    // 本页目录：滚动高亮
    preview.addEventListener('scroll', () => {
      if (scrollOutlineTimer) clearTimeout(scrollOutlineTimer);
      scrollOutlineTimer = setTimeout(syncPreviewOutlineScroll, 60);
    }, { passive: true });

    // 统一菜单按钮：点击展开单层分组弹层，搜索框即时过滤动作
    const appMenu = $('appMenu');
    const appMenuBtn = $('btnAppMenu');
    if (appMenu && appMenuBtn) {
      appMenuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        // 经典模式下 ☰ 直接切回紧凑菜单，保证任何时候都有重置入口
        if (document.body.classList.contains('classic-menu')) {
          setClassicMenu(false);
          renderRecentMenu();
          appMenu.classList.add('open');
          return;
        }
        const willOpen = !appMenu.classList.contains('open');
        closeFloatingMenus(appMenu);
        if (!willOpen) {
          appMenu.classList.remove('open');
          return;
        }
        renderRecentMenu();
        document.querySelectorAll('#topmenu .menu-group, #topmenu .menu-submenu').forEach((el) => el.classList.remove('open'));
        appMenu.classList.add('open');
        const search = $('appMenuSearch');
        if (search) {
          search.value = '';
          filterAppMenu('');
          setTimeout(() => search.focus(), 0);
        }
      });
      const search = $('appMenuSearch');
      if (search) search.addEventListener('input', () => filterAppMenu(search.value));
      const classicBtn = $('btnClassicMenu');
      if (classicBtn) classicBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setClassicMenu(true);
      });
      const compactBtn = $('btnCompactMenu');
      if (compactBtn) compactBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setClassicMenu(false);
      });
      const footPalette = document.querySelector('.app-menu-foot [data-action="tools:commandPalette"]');
      if (footPalette) footPalette.addEventListener('click', (event) => {
        event.stopPropagation();
        closeFloatingMenus();
        handleAction('tools:commandPalette');
      });
    }

    document.querySelectorAll('.menu-group > .menu-trigger').forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const group = trigger.parentElement;
        const wasOpen = group.classList.contains('open');
        closeFloatingMenus(group);
        const willOpen = !wasOpen;
        group.classList.toggle('open', willOpen);
        if (willOpen && group.dataset.menu === 'file') renderRecentMenu();
      });
    });
    document.querySelectorAll('.dropdown button[data-action]').forEach((item) => {
      item.addEventListener('click', () => {
        closeFloatingMenus();
        handleAction(item.dataset.action);
      });
    });
    document.addEventListener('click', () => closeFloatingMenus());

    const recentTrigger = document.querySelector('#recentSubmenu > .submenu-trigger');
    if (recentTrigger) {
      recentTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const wrap = $('recentSubmenu');
        const isOpen = wrap.classList.toggle('open');
        const dropdown = wrap.closest('.dropdown');
        if (dropdown) dropdown.classList.toggle('submenu-open', isOpen);
      });
    }
    const statusMoodBtn = $('statusMood');
    if (statusMoodBtn) {
      statusMoodBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const wrap = $('statusMoodWrap');
        const willOpen = !wrap.classList.contains('open');
        closeFloatingMenus(wrap);
        wrap.classList.toggle('open', willOpen);
      });
    }

    $('tabbar').addEventListener('contextmenu', (event) => {
      const el = event.target.closest('.tab');
      if (!el) return;
      event.preventDefault();
      const tab = state.tabs.find((item) => item.id === el.dataset.id);
      if (tab) showTabContextMenu(event.clientX, event.clientY, tab);
    });
    $('tabContextMenu').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const menu = $('tabContextMenu');
      const tab = state.tabs.find((item) => item.id === menu.dataset.tabId);
      const index = Number(menu.dataset.tabIndex);
      const action = button.dataset.action;
      menu.classList.remove('open');
      if (!tab) return;
      if (action === 'copyPath') {
        copyToClipboard(tab.path || tab.name, '已复制路径');
      } else if (action === 'closeOther') {
        closeTabsByFilter((item) => item.id !== tab.id);
      } else if (action === 'closeRight') {
        closeTabsByFilter((item) => state.tabs.indexOf(item) > index);
      } else if (action === 'closeLeft') {
        closeTabsByFilter((item) => state.tabs.indexOf(item) < index);
      } else if (action === 'closeAll') {
        closeTabsByFilter(() => true);
      }
    });
    document.addEventListener('mousedown', (event) => {
      if (!event.target.closest('#tabContextMenu')) $('tabContextMenu').classList.remove('open');
    });

    document.querySelectorAll('.tool-btn[data-cmd]').forEach((button) => {
      button.addEventListener('click', () => applyFormat(button.dataset.cmd));
    });

    setupCustomSelect('styleSelect', (value) => applyStyle(value));
    setupCustomSelect('sizeSelect', (value) => {
      state.fontSize = Number(value) || 16;
      applyFontSize();
      saveFontSize();
    });
    setupCustomSelect('lineHeightSelect', (value) => {
      state.lineHeight = Number(value) || 1.7;
      applyLineHeight();
      saveLineHeight();
    });
    // 缩进下拉：主按钮点击展开（与左侧其他下拉一致），菜单项走 data-action（无选中态）
    const indentRoot = $('indentPicker');
    if (indentRoot) {
      const indentTrigger = indentRoot.querySelector('.custom-select-trigger');
      if (indentTrigger) {
        indentTrigger.addEventListener('click', (event) => {
          event.stopPropagation();
          const wasOpen = indentRoot.classList.contains('open');
          closeFloatingMenus(indentRoot);
          indentRoot.classList.toggle('open', !wasOpen);
        });
      }
      indentRoot.querySelectorAll('.custom-select-menu button[data-action]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          indentRoot.classList.remove('open');
          handleAction(button.dataset.action);
        });
      });
    }
    // 上标/下标/公式下拉：主按钮展开，菜单项走 data-cmd（无选中态）
    const mathRoot = $('mathPicker');
    if (mathRoot) {
      const mathTrigger = mathRoot.querySelector('.custom-select-trigger');
      if (mathTrigger) {
        mathTrigger.addEventListener('click', (event) => {
          event.stopPropagation();
          const wasOpen = mathRoot.classList.contains('open');
          closeFloatingMenus(mathRoot);
          mathRoot.classList.toggle('open', !wasOpen);
        });
      }
      mathRoot.querySelectorAll('.custom-select-menu button[data-cmd]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          mathRoot.classList.remove('open');
          applyFormat(button.dataset.cmd);
        });
      });
    }
    bindTablePicker();
    bindColorPickers();
    bindPlayground();

    $('btnToggleTheme').addEventListener('click', toggleTheme);
    $('btnPublishNow').addEventListener('click', () => handleAction('publish:now'));

    // 工具栏溢出收纳需在全部按钮事件绑定完成后初始化
    initToolbarOverflow();

    $('btnCycleView').addEventListener('click', () => cycleViewMode());
    $('btnFocusMode').addEventListener('click', () => setFocusMode());
    $('btnFocusExit').addEventListener('click', () => setFocusMode(false));
    document.querySelectorAll('#focusBar [data-focus-view]').forEach((button) => {
      button.addEventListener('click', () => setViewMode(button.dataset.focusView));
    });
    editor.addEventListener('input', markDirty);
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.formatPainter) {
        event.preventDefault();
        cancelFormatPainter();
        toast('已取消格式刷', 'success');
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod) {
        const key = event.key.toLowerCase();
        if (key === 'z' && !event.shiftKey) {
          event.preventDefault();
          undo();
        } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
          event.preventDefault();
          redo();
        } else if (event.key === ']' || (event.code === 'BracketRight')) {
          event.preventDefault();
          indentLines(1);
        } else if (event.key === '[' || (event.code === 'BracketLeft')) {
          event.preventDefault();
          indentLines(-1);
        } else if (key === 'f') {
          event.preventDefault();
          openFindDialog();
        } else if (key === 'h') {
          event.preventDefault();
          openFindDialog();
          setTimeout(() => $('replaceInput').focus(), 80);
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        if (handleListEnter()) event.preventDefault();
      }
    });
    editor.addEventListener('paste', (event) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;
      const selection = { start: editor.selectionStart, end: editor.selectionEnd };
      const files = Array.from(clipboardData.files || []);
      const imageFile = files.find((file) => /^image\//i.test(file.type || '') || /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i.test(file.name || ''));
      if (imageFile) {
        // 桌面复制的图片文件：Chromium 只给文件引用，主进程 clipboard.readImage() 读不到位图。
        event.preventDefault();
        pasteImageFileFromClipboard(imageFile, selection).then((ok) => {
          if (!ok) toast('图片粘贴失败，请确认已打开工作区且图片格式受支持', 'error');
        });
        return;
      }

      const items = clipboardData.items;
      if (!items) return;
      let hasImage = false;
      for (const item of items) {
        if (item.kind === 'file' && /^image\//i.test(item.type)) { hasImage = true; break; }
      }
      if (!hasImage) return;
      // 其余图片来源（例如系统截图位图）继续走主进程剪贴板读取。
      event.preventDefault();
      pasteImageFromClipboard(selection).then((ok) => {
        if (!ok) toast('剪贴板中没有可用图片', 'error');
      });
    });
    editor.addEventListener('scroll', () => {
      gutter.scrollTop = editor.scrollTop;
      highlightLayer.scrollTop = editor.scrollTop;
      highlightLayer.scrollLeft = editor.scrollLeft;
      syncPreviewScroll();
      syncOutlineToCursor();
    });
    editor.addEventListener('compositionstart', () => document.body.classList.add('composing'));
    editor.addEventListener('compositionend', () => {
      document.body.classList.remove('composing');
      updateHighlight();
    });
    editor.addEventListener('click', updateCursor);
    editor.addEventListener('keyup', (event) => {
      if (state.formatPainter && event.shiftKey) applyFormatPainter();
      updateCursor();
    });
    editor.addEventListener('mouseup', () => {
      if (state.formatPainter) applyFormatPainter();
    });
    editor.addEventListener('select', updateCursor);

    preview.addEventListener('click', (event) => {
      const taskBox = event.target.closest('input[type="checkbox"][data-task]');
      if (taskBox) {
        toggleTaskInSource(taskBox.dataset.task, taskBox.checked);
        return;
      }
      const detailsSummary = event.target.closest('.vp-details summary');
      if (detailsSummary) return;
      const tab = event.target.closest('.vp-code-tab');
      if (!tab) return;
      const group = tab.dataset.group;
      const index = tab.dataset.index;
      preview.querySelectorAll(`.vp-code-tab[data-group="${group}"]`).forEach((element) => {
        element.classList.toggle('active', element.dataset.index === index);
      });
      preview.querySelectorAll(`.vp-code-panel[data-group="${group}"]`).forEach((element) => {
        element.classList.toggle('active', element.dataset.index === index);
      });
    });

    $('btnDiffClose').addEventListener('click', () => $('diffModal').classList.remove('open'));
    $('diffModal').addEventListener('click', (event) => {
      if (event.target === $('diffModal')) $('diffModal').classList.remove('open');
    });
    $('btnLinksClose').addEventListener('click', () => $('linksModal').classList.remove('open'));
    $('linksModal').addEventListener('click', (event) => {
      if (event.target === $('linksModal')) $('linksModal').classList.remove('open');
    });

    $('btnChooseWorkspace').addEventListener('click', chooseWorkspace);
    $('btnRefreshTree').addEventListener('click', async () => {
      const btn = $('btnRefreshTree');
      btn.classList.add('spinning');
      try {
        await refreshTree();
        if (!publishingMarksScan) await scanPublishMarks();
        toast('目录已刷新', 'success');
      } finally {
        setTimeout(() => btn.classList.remove('spinning'), 600);
      }
    });
    $('btnCollapseSidebar').addEventListener('click', () => toggleSidebar(true));
    document.querySelectorAll('.sidebar-tab').forEach((btn) => {
      btn.addEventListener('click', () => setSideTab(btn.dataset.sideTab));
    });
    bindSidebarRailDrag();
    bindSplitter();
    bindContextMenu();

    // 发布预览弹窗
    $('btnPublishCancel').addEventListener('click', () => $('publishModal').classList.remove('open'));
    $('btnPublishConfirm').addEventListener('click', confirmPublishBatch);
    $('pubCheckAll').addEventListener('change', (event) => {
      $('publishList').querySelectorAll('.pub-cb').forEach((cb) => { cb.checked = event.target.checked; });
      updatePublishSelection();
    });
    $('publishModal').addEventListener('click', (event) => {
      if (event.target === $('publishModal')) $('publishModal').classList.remove('open');
    });
    $('btnHistoryClose').addEventListener('click', () => $('historyModal').classList.remove('open'));
    $('historyModal').addEventListener('click', (event) => {
      if (event.target === $('historyModal')) $('historyModal').classList.remove('open');
    });

    // 多标签：点击切换，点 × 关闭
    $('tabbar').addEventListener('click', (event) => {
      const closeBtn = event.target.closest('.tab-close');
      if (closeBtn) {
        event.stopPropagation();
        closeTab(closeBtn.dataset.close);
        return;
      }
      const tabEl = event.target.closest('.tab');
      if (tabEl) activateTab(tabEl.dataset.id);
    });
    $('tabbar').addEventListener('auxclick', (event) => {
      // 中键关闭
      if (event.button === 1) {
        const tabEl = event.target.closest('.tab');
        if (tabEl) {
          event.preventDefault();
          closeTab(tabEl.dataset.id);
        }
      }
    });
    // 双击标签栏空白处新建文件：绑定在整个 pane-head 上，
    // 这样即使没有任何标签（tabbar 无内容、高度塌陷）也能双击触发
    const editorPaneHead = $('tabbar').parentElement;
    editorPaneHead.addEventListener('dblclick', (event) => {
      if (event.target.closest('.tab')) return; // 双击标签本身不新建
      openNewFileDialog();
    });

    // 全局文档搜索
    $('btnGlobalSearch').addEventListener('click', openGlobalSearch);
    $('btnSearchClose').addEventListener('click', closeGlobalSearch);
    $('globalSearchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runGlobalSearch, 220);
    });
    $('globalSearchInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        clearTimeout(searchTimer);
        runGlobalSearch();
      } else if (event.key === 'Escape') {
        closeGlobalSearch();
      }
    });
    ['searchRegex', 'searchCase', 'searchGroup'].forEach((id) => {
      const control = $(id);
      if (control) control.addEventListener('change', () => { if ($('globalSearchInput').value.trim()) runGlobalSearch(); });
    });
    if ($('btnSearchReplaceCurrent')) $('btnSearchReplaceCurrent').addEventListener('click', replaceCurrentFromSearch);
    if ($('statusStats')) $('statusStats').addEventListener('click', () => openWritingStats());

    document.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = String(event.key || '').toLowerCase();
      if (mod && key === 'k' && !event.shiftKey) {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (mod && key === 'k' && event.shiftKey) {
        event.preventDefault();
        chooseWorkspace();
        return;
      }
      if (event.key === 'Escape') {
        ['commandPaletteModal', 'publishReportModal', 'writingStatsModal', 'graphModal', 'templateModal', 'updateModal', 'draftRestoreModal'].forEach((id) => {
          const modal = $(id);
          if (modal && modal.classList.contains('open')) modal.classList.remove('open');
        });
      }
    });

    $('btnRefreshPreview').addEventListener('click', renderPreview);
    $('btnToggleLog').addEventListener('click', () => toggleLog());
    $('btnClearLog').addEventListener('click', () => { $('logList').innerHTML = ''; });

    // 新建文件弹窗
    $('btnNewFileCancel').addEventListener('click', () => $('newFileModal').classList.remove('open'));
    $('btnNewFileConfirm').addEventListener('click', confirmNewFile);
    $('newFileHint').addEventListener('click', chooseNewFileDir);

    // 已移出的文件夹弹窗
    $('btnExcludedClose').addEventListener('click', () => $('excludedModal').classList.remove('open'));
    $('excludedModal').addEventListener('click', (event) => {
      if (event.target === $('excludedModal')) $('excludedModal').classList.remove('open');
    });
    $('btnExcludedRestoreAll').addEventListener('click', async () => {
      try {
        await api.restoreAllExcludedDirs();
        await refreshTree();
        $('excludedModal').classList.remove('open');
        toast('已恢复全部文件夹', 'success');
      } catch (err) {
        toast(`恢复失败：${err.message}`, 'error');
      }
    });
    $('newFileName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') confirmNewFile();
    });
    $('newFileModal').addEventListener('click', (event) => {
      if (event.target === $('newFileModal')) $('newFileModal').classList.remove('open');
    });

    // 查找与替换弹窗
    const closeFind = () => $('findModal').classList.remove('open');
    $('btnFindCancel').addEventListener('click', closeFind);
    $('btnFindConfirm').addEventListener('click', () => doFind(editor.selectionEnd));
    $('btnFindReplace').addEventListener('click', doReplace);
    $('btnFindReplaceAll').addEventListener('click', doReplaceAll);
    const findKeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) doFind(editor.selectionStart, true);
        else doFind(editor.selectionEnd);
      }
    };
    $('findInput').addEventListener('keydown', findKeydown);
    $('replaceInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) doReplaceAll();
        else doReplace();
      }
    });
    $('findModal').addEventListener('click', (event) => {
      if (event.target === $('findModal')) closeFind();
    });

    // 通用确认弹窗（取消按钮已在 askConfirm 内绑定）
    $('confirmModal').addEventListener('click', (event) => {
      if (event.target === $('confirmModal')) $('btnConfirmCancel').click();
    });

    // 关闭确认弹窗：点遮罩等同取消，必须回传主进程否则窗口无法关闭
    $('closeConfirmModal').addEventListener('click', (event) => {
      if (event.target === $('closeConfirmModal')) $('btnCloseCancel').click();
    });

    $('btnSettingsCancel').addEventListener('click', () => $('settingsModal').classList.remove('open'));
    $('btnSettingsSave').addEventListener('click', saveSettings);
    if ($('btnCheckGithub')) $('btnCheckGithub').addEventListener('click', checkGithubConnection);
    $('settingsModal').addEventListener('click', (event) => {
      if (event.target === $('settingsModal')) $('settingsModal').classList.remove('open');
    });

    $('winMin').addEventListener('click', () => api.minimize());
    $('winMax').addEventListener('click', () => api.maximize());
    $('winClose').addEventListener('click', () => api.close());

    api.on('menu-action', (payload) => {
      if (payload && payload.action) handleAction(payload.action);
    });
    api.on('publish:log', (payload) => {
      if (payload && payload.message) log(payload.message, payload.level);
    });
    api.on('app:openFiles', (files) => {
      openFilesFromShell(files);
    });

    // 关闭窗口：主进程拦截 close 后发来询问，这里用软件自己的弹窗确认
    api.on('app:confirmClose', () => handleWindowCloseConfirm());

  // ---------- 链接体检 ----------
  async function openLinksCheck() {
    if (!state.workspace) { toast('请先选择工作区', 'error'); return; }
    const modal = $('linksModal');
    modal.classList.add('open');
    const list = $('linksList');
    $('linksDesc').textContent = '正在扫描工作区文档的内部链接与图片引用…';
    list.innerHTML = '<div class="history-empty">正在扫描，请稍候…</div>';
    try {
      const result = await api.checkLinks();
      const issues = result && result.issues ? result.issues : [];
      $('linksDesc').textContent = `已扫描 ${result.scanned} 个文档，发现 ${issues.length} 处失效引用。`;
      if (!issues.length) {
        list.innerHTML = '<div class="links-ok">✓ 没有发现失效的内部链接或图片引用</div>';
        return;
      }
      list.innerHTML = '';
      issues.forEach((issue) => {
        const row = document.createElement('div');
        row.className = 'links-row';
        row.innerHTML = `<span class="links-badge">${issue.image ? '图片' : '链接'}</span>`
          + `<span class="links-info"><span class="links-where">${escapeHtml(issue.relative)} : ${issue.line}</span><br>`
          + `<span class="links-target">${escapeHtml(issue.target)}</span></span>`
          + '<button type="button" class="links-jump">定位</button>';
        row.querySelector('.links-jump').addEventListener('click', async () => {
          await openFile(issue.file, issue.line);
          modal.classList.remove('open');
        });
        list.appendChild(row);
      });
    } catch (err) {
      list.innerHTML = `<div class="history-empty">扫描失败：${escapeHtml(cleanError(err))}</div>`;
    }
  }

  // ---------- Frontmatter 可视化编辑 ----------
  function parseFrontmatter(source) {
    const text = String(source || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    if (!lines.length || lines[0].trim() !== '---') return { fields: {}, body: text, found: false };
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() !== '---') continue;
      const fields = {};
      lines.slice(1, i).forEach((line) => {
        const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (match) fields[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      });
      return { fields, body: lines.slice(i + 1).join('\n'), found: true };
    }
    return { fields: {}, body: text, found: false };
  }

  function openFrontmatterDialog() {
    const parsed = parseFrontmatter(editor.value);
    const fields = parsed.fields;
    $('fmTitle').value = fields.title || '';
    $('fmDescription').value = fields.description || '';
    $('fmOrder').value = fields.order || '';
    const known = new Set(['title', 'description', 'order']);
    $('fmExtra').value = Object.keys(fields)
      .filter((key) => !known.has(key))
      .map((key) => `${key}: ${fields[key]}`)
      .join('\n');
    $('btnFrontmatterRemove').style.visibility = parsed.found ? 'visible' : 'hidden';
    const modal = $('frontmatterModal');
    modal.classList.add('open');

    const cleanup = () => {
      modal.classList.remove('open');
      $('btnFrontmatterSave').removeEventListener('click', onSave);
      $('btnFrontmatterCancel').removeEventListener('click', cleanup);
      $('btnFrontmatterRemove').removeEventListener('click', onRemove);
      modal.removeEventListener('click', onBackdrop);
    };
    const build = () => {
      const lines = ['---'];
      const title = $('fmTitle').value.trim();
      const description = $('fmDescription').value.trim();
      const order = $('fmOrder').value.trim();
      if (title) lines.push(`title: ${title}`);
      if (description) lines.push(`description: ${description}`);
      if (order) lines.push(`order: ${order}`);
      $('fmExtra').value.split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => lines.push(line));
      lines.push('---');
      return lines.join('\n') + '\n' + parsed.body.replace(/^\n/, '');
    };
    const onSave = () => {
      editor.value = build();
      markDirty();
      updateGutter();
      updateHighlight();
      schedulePreview();
      cleanup();
      toast('已更新文档元信息', 'success');
    };
    const onRemove = () => {
      editor.value = parsed.body.replace(/^\n/, '');
      markDirty();
      updateGutter();
      updateHighlight();
      schedulePreview();
      cleanup();
      toast('已移除 Frontmatter', 'success');
    };
    const onBackdrop = (event) => { if (event.target === modal) cleanup(); };
    $('btnFrontmatterSave').addEventListener('click', onSave);
    $('btnFrontmatterCancel').addEventListener('click', cleanup);
    $('btnFrontmatterRemove').addEventListener('click', onRemove);
    modal.addEventListener('click', onBackdrop);
    setTimeout(() => $('fmTitle').focus(), 30);
  }

  // ---------- 快速打开（Ctrl+P） ----------
  function collectQuickFiles(nodes, out) {
    for (const node of (nodes || [])) {
      if (node.type === 'dir') collectQuickFiles(node.children, out);
      else if (node.type === 'file' || node.type === 'image') {
        if (/\.(md|markdown|mdx)$/i.test(node.name || node.path || '')) {
          out.push({ path: node.path, name: node.name || basename(node.path), relative: relativeToWorkspace(node.path) });
        }
      }
    }
    return out;
  }

  function fuzzyScore(text, query) {
    const t = String(text).toLowerCase();
    const q = String(query).toLowerCase().trim();
    if (!q) return 1;
    const direct = t.indexOf(q);
    if (direct >= 0) return 1000 - direct * 4;
    let ti = 0;
    let score = 0;
    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found < 0) return -1;
      score += found === ti ? 2 : 1;
      ti = found + 1;
    }
    return score;
  }

  async function openQuickOpen() {
    const modal = $('quickOpenModal');
    const input = $('quickOpenInput');
    const list = $('quickOpenList');
    let files = [];
    try { files = collectQuickFiles(await api.getTree(), []); } catch (_) { files = []; }
    // 最近打开放在前面，重复路径去重
    const recent = getRecentFiles().filter((p) => files.some((f) => f.path === p));
    const recentFiles = recent.map((p) => files.find((f) => f.path === p));
    const ordered = [...recentFiles, ...files.filter((f) => !recent.includes(f.path))];
    let matches = ordered;
    let activeIndex = 0;

    function render() {
      const q = input.value.trim();
      matches = ordered
        .map((file) => ({ file, score: Math.max(fuzzyScore(file.name, q), fuzzyScore(file.relative, q) - 3) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((entry) => entry.file);
      if (activeIndex >= matches.length) activeIndex = 0;
      if (!matches.length) {
        list.innerHTML = '<div class="quick-open-empty">没有匹配的文档</div>';
        return;
      }
      list.innerHTML = matches.map((file, index) => `<button type="button" class="quick-open-item${index === activeIndex ? ' active' : ''}" data-index="${index}">`
        + '<svg class="icon"><use href="#i-file-modern"></use></svg>'
        + `<span class="qo-info"><span class="qo-name">${escapeHtml(file.name)}</span><span class="qo-path">${escapeHtml(file.relative)}</span></span>`
        + '</button>').join('');
      const active = list.querySelector('.quick-open-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    const cleanup = () => {
      modal.classList.remove('open');
      input.removeEventListener('input', render);
      input.removeEventListener('keydown', onKey);
      list.removeEventListener('click', onPick);
      modal.removeEventListener('click', onBackdrop);
    };
    const pick = async (file) => {
      if (!file) return;
      cleanup();
      await openFile(file.path);
    };
    const onPick = (event) => {
      const button = event.target.closest('.quick-open-item');
      if (button) pick(matches[Number(button.dataset.index)]);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); cleanup(); }
      else if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); activeIndex = (activeIndex + 1) % matches.length; render(); }
      else if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); activeIndex = (activeIndex - 1 + matches.length) % matches.length; render(); }
      else if (event.key === 'Enter' && matches.length) { event.preventDefault(); pick(matches[activeIndex]); }
    };
    const onBackdrop = (event) => { if (event.target === modal) cleanup(); };

    input.value = '';
    activeIndex = 0;
    render();
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKey);
    list.addEventListener('click', onPick);
    modal.addEventListener('click', onBackdrop);
    modal.classList.add('open');
    setTimeout(() => input.focus(), 30);
  }

  // ---------- 标签页右键菜单 ----------
  async function closeTabsByFilter(filter) {
    const targets = state.tabs.filter(filter);
    if (!targets.length) return;
    const dirtyNames = targets.filter((tab) => tab.dirty).map((tab) => tab.name);
    if (dirtyNames.length) {
      const names = dirtyNames.slice(0, 4).join('、') + (dirtyNames.length > 4 ? ' 等' : '');
      const ok = await askConfirm('关闭标签', `以下标签有未保存的更改：${names}。\n关闭后将丢弃这些更改，确认继续？`);
      if (!ok) return;
    }
    const closingIds = new Set(targets.map((tab) => tab.id));
    const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
    state.tabs = state.tabs.filter((tab) => !closingIds.has(tab.id));
    if (closingIds.has(state.activeTabId)) {
      const next = state.tabs[Math.min(activeIndex, state.tabs.length - 1)] || null;
      state.activeTabId = '';
      if (next) activateTab(next.id);
      else {
        state.currentFile = '';
        state.dirty = false;
        state.lastSavedAt = null;
        historyLocked = true;
        editor.value = '';
        history.stack = [''];
        history.index = 0;
        historyLocked = false;
        updateStatus();
        updateGutter();
        updateHighlight();
        schedulePreview();
      }
    }
    renderTabs();
    persistSession();
  }

  function showTabContextMenu(clientX, clientY, tab) {
    const menu = $('tabContextMenu');
    const index = state.tabs.findIndex((item) => item.id === tab.id);
    const items = [
      { icon: 'i-copy', label: '复制路径', action: 'copyPath' },
      { divider: true },
      { icon: 'i-close', label: '关闭其他标签', action: 'closeOther' },
      { icon: 'i-close', label: '关闭右侧标签', action: 'closeRight' },
      { icon: 'i-close', label: '关闭左侧标签', action: 'closeLeft' },
      { icon: 'i-trash', label: '关闭全部标签', action: 'closeAll', danger: true }
    ];
    menu.innerHTML = items.map((item) => item.divider
      ? '<div class="context-divider"></div>'
      : `<button type="button" class="context-item ${item.danger ? 'danger' : ''}" data-action="${item.action}"><svg class="icon"><use href="#${item.icon}"></use></svg><span>${escapeHtml(item.label)}</span></button>`
    ).join('');
    menu.classList.add('open');
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    menu.dataset.tabId = tab.id;
    menu.dataset.tabIndex = String(index);
  }

  // 全局标签快捷键
  document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.focusMode && !state.formatPainter) {
        setFocusMode(false);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key === 'w') {
        if (state.activeTabId) {
          event.preventDefault();
          closeTab(state.activeTabId);
        }
      } else if (event.key === 'Tab') {
        if (state.tabs.length > 1) {
          event.preventDefault();
          const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
          const next = state.tabs[(idx + (event.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length];
          activateTab(next.id);
        }
      } else if (event.key.toLowerCase() === 'p' && !event.shiftKey) {
        event.preventDefault();
        openQuickOpen();
      }
    });
  }

  // ---------- 草稿备份与崩溃恢复 ----------
  function scheduleDraftBackup() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = null;
      const tab = activeTab();
      if (tab && tab.path && state.dirty) api.saveDraft(tab.path, editor.value).catch(() => {});
    }, 1800);
  }

  async function checkDraftRestore() {
    if (draftRestoreChecked) return;
    draftRestoreChecked = true;
    try {
      const drafts = await api.listDrafts();
      if (drafts && drafts.length) openDraftRestore(drafts);
    } catch (_err) { /* 草稿检查失败不影响启动 */ }
  }

  function openDraftRestore(drafts) {
    const modal = $('draftRestoreModal');
    const list = $('draftList');
    list.innerHTML = drafts.map((draft, index) => {
      const time = new Date(draft.savedAt || Date.now()).toLocaleString('zh-CN', { hour12: false });
      return `<label class="draft-item"><input type="checkbox" data-draft-id="${escapeHtml(draft.id)}" ${index === 0 ? 'checked' : ''} />`
        + `<span><span class="draft-name">${escapeHtml(basename(draft.filePath))}</span>`
        + `<span class="draft-meta">${escapeHtml(draft.filePath)}<br>${escapeHtml(time)} · ${draft.content.length} 字符</span></span></label>`;
    }).join('');
    modal.classList.add('open');

    const cleanup = () => {
      modal.classList.remove('open');
      $('btnDraftIgnore').onclick = null;
      $('btnDraftClear').onclick = null;
      $('btnDraftRestore').onclick = null;
      modal.onclick = null;
    };
    const selectedIds = () => Array.from(list.querySelectorAll('input:checked')).map((item) => item.dataset.draftId);

    $('btnDraftIgnore').onclick = cleanup;
    $('btnDraftClear').onclick = async () => {
      const ids = selectedIds();
      for (const id of ids) await api.deleteDraft(id).catch(() => {});
      toast(ids.length ? `已删除 ${ids.length} 份草稿` : '未选择草稿', 'success');
      cleanup();
    };
    $('btnDraftRestore').onclick = async () => {
      const ids = selectedIds();
      if (!ids.length) { toast('请先选择要恢复的草稿', 'error'); return; }
      let restored = 0;
      for (const id of ids) {
        const draft = await api.readDraft(id).catch(() => null);
        if (!draft || typeof draft.content !== 'string') continue;
        let tab = state.tabs.find((item) => samePathKey(item.path, draft.filePath));
        if (!tab) {
          try { await openFile(draft.filePath); } catch (_err) { continue; }
          tab = activeTab();
        } else {
          activateTab(tab.id);
        }
        editor.value = draft.content;
        markDirty();
        api.deleteDraft(id).catch(() => {});
        restored += 1;
      }
      cleanup();
      toast(restored ? `已恢复 ${restored} 份草稿，记得保存` : '没有可恢复的草稿', restored ? 'success' : 'error');
    };
    modal.onclick = (event) => { if (event.target === modal) cleanup(); };
  }

  // ---------- 命令面板 ----------
  function commandScore(text, query) {
    const t = String(text || '').toLowerCase();
    const q = String(query || '').toLowerCase().trim();
    if (!q) return 1;
    const direct = t.indexOf(q);
    if (direct >= 0) return 1000 - direct * 3;
    let ti = 0;
    let score = 0;
    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found < 0) return -1;
      score += found === ti ? 2 : 1;
      ti = found + 1;
    }
    return score;
  }

  function openCommandPalette() {
    const modal = $('commandPaletteModal');
    const input = $('commandInput');
    const list = $('commandList');
    const commands = [
      { title: '新建文档', group: '文件', icon: '#i-file-plus', run: () => openNewFileDialog() },
      { title: '从模板新建文档', group: '文件', icon: '#i-file-plus', run: () => openTemplatePicker() },
      { title: '快速打开文档', group: '文件', icon: '#i-search', run: () => openQuickOpen() },
      { title: '选择工作区', group: '文件', icon: '#i-folder', run: () => chooseWorkspace() },
      { title: '保存当前文档', group: '文件', icon: '#i-file-modern', run: () => saveFile({}) },
      { title: '另存为', group: '文件', icon: '#i-file-modern', run: () => saveAs({}) },
      { title: '导出 PDF', group: '文件', icon: '#i-pdf', run: () => exportPdf() },
      { title: '全局搜索', group: '编辑', icon: '#i-search', run: () => openGlobalSearch() },
      { title: '查找与替换', group: '编辑', icon: '#i-search', run: () => openFindDialog() },
      { title: '插入行内公式', group: '编辑', icon: '#i-sigma', run: () => applyFormat('inlineMath') },
      { title: '插入公式块', group: '编辑', icon: '#i-sigma', run: () => applyFormat('mathBlock') },
      { title: '插入上标', group: '编辑', icon: '#i-sigma', run: () => applyFormat('superscript') },
      { title: '插入下标', group: '编辑', icon: '#i-sigma', run: () => applyFormat('subscript') },
      { title: '分屏显示', group: '视图', icon: '#i-view-split', run: () => setViewMode('split') },
      { title: '仅编辑器', group: '视图', icon: '#i-view-editor', run: () => setViewMode('editor') },
      { title: '仅预览', group: '视图', icon: '#i-view-preview', run: () => setViewMode('preview') },
      { title: '切换亮色/暗色主题', group: '视图', icon: '#i-moon', run: () => toggleTheme() },
      { title: '切换专注模式', group: '视图', icon: '#i-focus', run: () => setFocusMode() },
      { title: '显示/隐藏侧边栏', group: '视图', icon: '#i-panel-left', run: () => toggleSidebar() },
      { title: '发布前体检', group: '工具', icon: '#i-help', run: () => openPublishReport() },
      { title: '链接体检', group: '工具', icon: '#i-link', run: () => openLinksCheck() },
      { title: '写作统计', group: '工具', icon: '#i-log', run: () => openWritingStats() },
      { title: '文档关系图谱', group: '工具', icon: '#i-link', run: () => openGraph() },
      { title: '本地版本历史', group: '工具', icon: '#i-refresh', run: () => openHistory() },
      { title: '语法演练场', group: '工具', icon: '#i-edit', run: () => openPlayground() },
      { title: '预览变更并发布', group: '发布', icon: '#i-publish', run: () => openPublishDialog() },
      { title: 'GitHub 发布设置', group: '发布', icon: '#i-settings', run: () => openSettings() },
      { title: '从仓库拉取', group: '发布', icon: '#i-refresh', run: () => pullFromRepository() },
      { title: '检查更新', group: '帮助', icon: '#i-refresh', run: () => checkForUpdate() }
    ];
    let matches = commands;
    let activeIndex = 0;

    function render() {
      const q = input.value.trim();
      matches = commands
        .map((cmd) => ({ cmd, score: commandScore(`${cmd.title} ${cmd.group}`, q) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map((entry) => entry.cmd);
      if (activeIndex >= matches.length) activeIndex = 0;
      if (!matches.length) {
        list.innerHTML = '<div class="quick-open-empty">没有匹配的命令</div>';
        return;
      }
      list.innerHTML = matches.map((cmd, index) => `<button type="button" class="quick-open-item${index === activeIndex ? ' active' : ''}" data-index="${index}">`
        + `<svg class="icon"><use href="${cmd.icon}"></use></svg>`
        + `<span class="qo-info"><span class="qo-name">${escapeHtml(cmd.title)}</span><span class="qo-path">${escapeHtml(cmd.group)}</span></span>`
        + '</button>').join('');
      const active = list.querySelector('.quick-open-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    const cleanup = () => {
      modal.classList.remove('open');
      input.removeEventListener('input', render);
      input.removeEventListener('keydown', onKey);
      list.removeEventListener('click', onPick);
      modal.removeEventListener('click', onBackdrop);
    };
    const pick = (cmd) => {
      if (!cmd) return;
      cleanup();
      try { cmd.run(); } catch (err) { toast(`命令执行失败：${err.message}`, 'error'); }
    };
    const onPick = (event) => {
      const button = event.target.closest('.quick-open-item');
      if (button) pick(matches[Number(button.dataset.index)]);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); cleanup(); }
      else if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); activeIndex = (activeIndex + 1) % matches.length; render(); }
      else if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); activeIndex = (activeIndex - 1 + matches.length) % matches.length; render(); }
      else if (event.key === 'Enter' && matches.length) { event.preventDefault(); pick(matches[activeIndex]); }
    };
    const onBackdrop = (event) => { if (event.target === modal) cleanup(); };

    commandItems = commands;
    commandIndex = 0;
    input.value = '';
    render();
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKey);
    list.addEventListener('click', onPick);
    modal.addEventListener('click', onBackdrop);
    modal.classList.add('open');
    setTimeout(() => input.focus(), 30);
  }

  // ---------- 发布前体检 ----------
  async function openPublishReport() {
    if (!state.workspace) { toast('请先选择工作区', 'error'); return; }
    const modal = $('publishReportModal');
    const list = $('reportList');
    modal.classList.add('open');
    $('reportDesc').textContent = '正在检查链接、图片、文档结构与发布配置…';
    list.innerHTML = '<div class="history-empty">正在体检，请稍候…</div>';
    let report = null;
    let filter = 'all';

    const draw = () => {
      if (!report) return;
      const items = report.items.filter((item) => filter === 'all' || item.level === filter);
      $('reportDesc').textContent = `已扫描 ${report.scanned} 个文档 · 错误 ${report.summary.error} · 警告 ${report.summary.warning} · 提示 ${report.summary.info}`;
      if (!items.length) {
        list.innerHTML = '<div class="stats-empty">这一类没有问题 🎉</div>';
        return;
      }
      list.innerHTML = items.map((item, index) => (
        `<div class="report-item${item.file ? ' clickable' : ''}" data-index="${index}">`
        + `<span class="report-level ${item.level}">${item.level === 'error' ? '错误' : item.level === 'warning' ? '警告' : '提示'}</span>`
        + `<span><span class="report-title">${escapeHtml(item.message)}</span>`
        + `<span class="report-meta">${escapeHtml(item.category)}${item.file ? ` · ${escapeHtml(item.file)}${item.line ? `:${item.line}` : ''}` : ''}</span>`
        + (item.fixHint ? `<span class="report-hint">建议：${escapeHtml(item.fixHint)}</span>` : '')
        + '</span></div>'
      )).join('');
      list.querySelectorAll('.report-item').forEach((row) => {
        row.addEventListener('click', async () => {
          const item = items[Number(row.dataset.index)];
          if (!item || !item.file) return;
          if (/\.mdx?$/i.test(item.file)) {
            modal.classList.remove('open');
            try { await openFile(item.file, item.line || 1); } catch (err) { toast(`打开失败：${err.message}`, 'error'); }
          } else {
            try { await api.revealPath(item.file); } catch (_err) { /* 忽略无法定位的图片 */ }
          }
        });
      });
    };

    try {
      report = await api.checkPublish();
      draw();
    } catch (err) {
      list.innerHTML = `<div class="stats-empty">体检失败：${escapeHtml(err.message)}</div>`;
    }

    modal.querySelectorAll('.report-filter').forEach((btn) => {
      btn.onclick = () => {
        filter = btn.dataset.reportFilter;
        modal.querySelectorAll('.report-filter').forEach((item) => item.classList.toggle('active', item === btn));
        draw();
      };
    });
    $('btnReportClose').onclick = () => modal.classList.remove('open');
    modal.onclick = (event) => { if (event.target === modal) modal.classList.remove('open'); };
  }

  // ---------- 写作统计 ----------
  function analyzeWriting(source) {
    const text = String(source || '');
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/```[\s\S]*?```/g, '');
    const lines = body.split(/\r?\n/);
    const chinese = (body.match(/[\u4e00-\u9fff]/g) || []).length;
    const words = (body.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    const headings = [];
    lines.forEach((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 });
    });
    const paragraphs = body.split(/\r?\n\s*\r?\n/).filter((part) => part.trim()).length;
    const issues = [];

    for (let i = 1; i < headings.length; i += 1) {
      if (headings[i].level - headings[i - 1].level > 1) {
        issues.push({ line: headings[i].line, message: `标题层级跳跃：${headings[i - 1].level} 级后直接到 ${headings[i].level} 级` });
      }
    }

    const phraseCount = new Map();
    for (const match of body.matchAll(/[\u4e00-\u9fff]{2,4}/g)) {
      const word = match[0];
      if (/^(这个|那个|可以|我们|你们|他们|一个|没有|就是|自己|因为|所以|但是|如果|已经|还是|这样|那样)$/.test(word)) continue;
      phraseCount.set(word, (phraseCount.get(word) || 0) + 1);
    }
    [...phraseCount.entries()].filter(([, count]) => count >= 5).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([word, count]) => issues.push({ line: 0, message: `「${word}」出现 ${count} 次，可考虑替换部分表达` }));

    lines.forEach((line, index) => {
      if (/[\u4e00-\u9fff][A-Za-z0-9]|[A-Za-z0-9][\u4e00-\u9fff]/.test(line) && !/^\s*(https?:|`|\$\$)/.test(line)) {
        issues.push({ line: index + 1, message: '中文与英文/数字相邻，建议加空格' });
      }
      if (line.length > 240) issues.push({ line: index + 1, message: `单行 ${line.length} 字，建议拆分段落` });
    });

    return {
      chars: chinese + words,
      chinese,
      words,
      lines: lines.length,
      paragraphs,
      headings: headings.length,
      readingMinutes: Math.max(1, Math.ceil((chinese + words) / 400)),
      issues: issues.slice(0, 30)
    };
  }

  function openWritingStats() {
    const modal = $('writingStatsModal');
    const stats = analyzeWriting(editor.value);
    $('statsDesc').textContent = state.currentFile ? `${basename(state.currentFile)} · 当前文档写作概况` : '当前文档写作概况';
    const cards = [
      ['字数', stats.chars], ['中文字', stats.chinese], ['英文词', stats.words],
      ['段落', stats.paragraphs], ['标题', stats.headings], ['阅读时长', `${stats.readingMinutes} 分钟`]
    ];
    $('statsGrid').innerHTML = cards.map(([label, value]) => `<div class="stat-card"><span class="stat-value">${escapeHtml(String(value))}</span><span class="stat-label">${label}</span></div>`).join('');
    $('statsIssues').innerHTML = stats.issues.length
      ? stats.issues.map((issue, index) => `<div class="stats-issue" data-index="${index}"><span class="issue-line">${issue.line ? `第 ${issue.line} 行` : '全文'}</span>${escapeHtml(issue.message)}</div>`).join('')
      : '<div class="stats-empty">没有发现明显问题，写得很稳 👍</div>';
    $('statsIssues').querySelectorAll('.stats-issue').forEach((row) => {
      row.addEventListener('click', () => {
        const issue = stats.issues[Number(row.dataset.index)];
        if (!issue || !issue.line) return;
        modal.classList.remove('open');
        focusLine(issue.line);
      });
    });
    modal.classList.add('open');
    $('btnStatsClose').onclick = () => modal.classList.remove('open');
    modal.onclick = (event) => { if (event.target === modal) modal.classList.remove('open'); };
  }

  // ---------- 文档关系图谱 ----------
  async function openGraph() {
    if (!state.workspace) { toast('请先选择工作区', 'error'); return; }
    const modal = $('graphModal');
    modal.classList.add('open');
    $('graphDesc').textContent = '正在扫描工作区文档内链…';
    $('graphFilter').value = '';
    $('graphStage').innerHTML = '';
    $('graphSide').innerHTML = '';
    try {
      const data = await api.buildGraph();
      renderGraph(data);
    } catch (err) {
      $('graphDesc').textContent = `扫描失败：${err.message}`;
    }
    $('btnGraphClose').onclick = () => modal.classList.remove('open');
    modal.onclick = (event) => { if (event.target === modal) modal.classList.remove('open'); };
  }

  function renderGraph(data) {
    const stage = $('graphStage');
    const side = $('graphSide');
    const filter = $('graphFilter');
    const allNodes = data.nodes || [];
    const allLinks = data.links || [];
    if (!allNodes.length) {
      stage.innerHTML = '<div class="stats-empty">当前工作区没有可展示的 Markdown 文档</div>';
      side.innerHTML = '';
      return;
    }
    $('graphDesc').textContent = `${data.stats.documents} 个文档 · ${data.stats.links} 条内链 · ${data.stats.isolated} 个孤立文档`;

    const ns = 'http://www.w3.org/2000/svg';
    const CELL = 150;
    const PAD = 120;

    function draw(keyword) {
      const needle = String(keyword || '').trim().toLowerCase();
      const nodes = needle
        ? allNodes.filter((node) => node.name.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle))
        : allNodes.slice();
      const keep = new Set(nodes.map((node) => node.id));
      const links = allLinks.filter((link) => keep.has(link.source) && keep.has(link.target));

      stage.innerHTML = '';
      side.innerHTML = '';
      if (!nodes.length) {
        stage.innerHTML = '<div class="stats-empty">没有匹配的文档</div>';
        return;
      }

      const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.25)));
      const rows = Math.ceil(nodes.length / cols);
      const worldW = cols * CELL + PAD * 2;
      const worldH = rows * CELL + PAD * 2;
      const positions = new Map();
      nodes.forEach((node, index) => {
        positions.set(node.id, {
          x: PAD + (index % cols) * CELL + CELL / 2,
          y: PAD + Math.floor(index / cols) * CELL + CELL / 2
        });
      });

      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const root = document.createElementNS(ns, 'g');
      svg.appendChild(root);
      stage.appendChild(svg);

      for (const link of links) {
        const a = positions.get(link.source);
        const b = positions.get(link.target);
        if (!a || !b) continue;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
        line.setAttribute('class', 'graph-edge');
        root.appendChild(line);
      }

      const nodeEls = [];
      for (const node of nodes) {
        const pos = positions.get(node.id);
        const group = document.createElementNS(ns, 'g');
        group.setAttribute('class', `graph-node${node.isolated ? ' isolated' : ''}${node.inDegree >= 3 ? ' hub' : ''}`);
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('r', String(Math.min(12, 5 + node.inDegree * 0.9)));
        group.appendChild(circle);
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('y', '24');
        label.textContent = node.name.length > 16 ? `${node.name.slice(0, 15)}…` : node.name;
        group.appendChild(label);
        const title = document.createElementNS(ns, 'title');
        title.textContent = `${node.name}\n${node.id}${node.inDegree || node.outDegree ? `\n入链 ${node.inDegree} · 出链 ${node.outDegree}` : ''}`;
        group.appendChild(title);
        let dragged = false;
        group.addEventListener('click', () => {
          if (dragged) return;
          $('graphModal').classList.remove('open');
          openFile(node.filePath || node.id).catch((err) => toast(`打开失败：${err.message}`, 'error'));
        });
        group.addEventListener('pointerdown', () => { dragged = false; });
        group.addEventListener('pointermove', (event) => {
          if (event.buttons === 1 && view.moved) dragged = true;
        });
        root.appendChild(group);
        nodeEls.push({ group, x: pos.x, y: pos.y });
      }

      const view = { k: 1, tx: 0, ty: 0, moved: false };
      function applyView() {
        root.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
        nodeEls.forEach((item) => item.group.setAttribute('transform', `translate(${item.x},${item.y}) scale(${1 / view.k})`));
        stage.classList.toggle('graph-labels-hidden', view.k < 0.55);
      }
      function fit() {
        const box = stage.getBoundingClientRect();
        const vw = Math.max(1, box.width);
        const vh = Math.max(1, box.height);
        const k = Math.min(vw / worldW, vh / worldH);
        view.k = Math.max(0.05, Math.min(2, k));
        view.tx = (vw - worldW * view.k) / 2;
        view.ty = (vh - worldH * view.k) / 2;
        applyView();
      }
      function zoomAt(factor) {
        const box = stage.getBoundingClientRect();
        const cx = Math.max(1, box.width) / 2;
        const cy = Math.max(1, box.height) / 2;
        const wx = (cx - view.tx) / view.k;
        const wy = (cy - view.ty) / view.k;
        view.k = Math.max(0.05, Math.min(4, view.k * factor));
        view.tx = cx - wx * view.k;
        view.ty = cy - wy * view.k;
        applyView();
      }
      $('btnGraphFit').onclick = fit;
      $('btnGraphZoomIn').onclick = () => zoomAt(1.3);
      $('btnGraphZoomOut').onclick = () => zoomAt(1 / 1.3);
      svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const box = stage.getBoundingClientRect();
        const px = event.clientX - box.left;
        const py = event.clientY - box.top;
        const wx = (px - view.tx) / view.k;
        const wy = (py - view.ty) / view.k;
        view.k = Math.max(0.05, Math.min(4, view.k * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        view.tx = px - wx * view.k;
        view.ty = py - wy * view.k;
        applyView();
      }, { passive: false });
      let dragStart = null;
      svg.addEventListener('pointerdown', (event) => {
        dragStart = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
        view.moved = false;
        svg.setPointerCapture(event.pointerId);
      });
      svg.addEventListener('pointermove', (event) => {
        if (!dragStart) return;
        const dx = event.clientX - dragStart.x;
        const dy = event.clientY - dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) view.moved = true;
        view.tx = dragStart.tx + dx;
        view.ty = dragStart.ty + dy;
        applyView();
      });
      svg.addEventListener('pointerup', () => { dragStart = null; });
      svg.addEventListener('pointercancel', () => { dragStart = null; });
      fit();

      if (!links.length) {
        const hint = document.createElement('div');
        hint.className = 'graph-hint';
        hint.textContent = '该工作区暂无文档内链。在文档里用 [标题](相对路径.md) 互链后，节点之间就会出现连线。当前按文件名顺序平铺。';
        stage.appendChild(hint);
      }

      const hubs = (data.stats.hubs || []).filter((node) => node.inDegree > 0 && keep.has(node.id));
      const buttons = (list) => list.map((node) => `<button type="button" class="graph-side-item" data-file="${escapeHtml(node.filePath || node.id)}" title="${escapeHtml(node.id)} · 入链 ${node.inDegree}">${escapeHtml(node.name)} · ${node.inDegree} 入链</button>`).join('');
      side.innerHTML = '<div class="graph-side-title">热门文档</div>'
        + (hubs.length ? buttons(hubs) : '<div class="graph-side-empty">暂无内链数据</div>')
        + `<div class="graph-side-title" style="margin-top:14px">${needle ? '匹配文档' : '文档列表'}</div>`
        + buttons(nodes.slice(0, 30))
        + (nodes.length > 30 ? `<div class="graph-side-empty">仅显示前 30 个，可在上方继续筛选</div>` : '');
      side.querySelectorAll('.graph-side-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          $('graphModal').classList.remove('open');
          openFile(btn.dataset.file).catch((err) => toast(`打开失败：${err.message}`, 'error'));
        });
      });
    }

    draw('');
    filter.oninput = () => draw(filter.value);
  }

  // ---------- 模板 ----------
  async function openTemplatePicker() {
    const modal = $('templateModal');
    const list = $('templateList');
    modal.classList.add('open');
    list.innerHTML = '<div class="history-empty">加载中…</div>';
    let templates = [];
    try {
      templates = (await api.listTemplates()) || [];
      list.innerHTML = templates.map((item, index) => (
        `<div class="template-item" data-index="${index}"><span><span class="template-name">${escapeHtml(item.name)}</span>`
        + `<span class="template-desc">${escapeHtml(item.description || '')}</span></span>`
        + `<span class="template-tag">${item.builtin ? '内置' : '自定义'}</span></div>`
      )).join('');
      list.querySelectorAll('.template-item').forEach((row) => {
        row.addEventListener('click', () => {
          const template = templates[Number(row.dataset.index)];
          modal.classList.remove('open');
          if (template) openNewFileDialog(template);
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="stats-empty">加载模板失败：${escapeHtml(err.message)}</div>`;
    }
    $('btnTemplateCancel').onclick = () => modal.classList.remove('open');
    $('btnTemplateFolder').onclick = async () => {
      try {
        const dir = await api.openTemplateFolder();
        copyToClipboard(dir, '模板目录路径已复制，可在资源管理器中打开');
      } catch (err) { toast(`打开模板目录失败：${err.message}`, 'error'); }
    };
    modal.onclick = (event) => { if (event.target === modal) modal.classList.remove('open'); };
  }

  // ---------- 更新检查 ----------
  async function checkForUpdate() {
    const modal = $('updateModal');
    const cfg = state.config && state.config.update ? state.config.update : {};
    if (cfg.enabled === false) { toast('更新检查已在设置中关闭', 'info'); return; }
    modal.classList.add('open');
    $('updateDesc').textContent = '正在查询 GitHub Releases…';
    $('updateContent').innerHTML = '';
    $('btnUpdateOpen').hidden = true;
    try {
      const result = await api.checkUpdate();
      if (!result.configured) {
        $('updateDesc').textContent = '尚未配置更新仓库';
        $('updateContent').innerHTML = `<div class="update-version"><span>当前版本</span><strong>${escapeHtml(result.current)}</strong></div>`
          + '<p>在「设置 → 更新检查」填写 owner/repo 后，即可手动检查最新版本。</p>';
        return;
      }
      $('updateDesc').textContent = result.hasUpdate ? '发现新版本' : '当前已是最新版本';
      $('updateContent').innerHTML = `<div class="update-version"><span>当前版本</span><strong>${escapeHtml(result.current)}</strong></div>`
        + `<div class="update-version"><span>最新版本</span><strong>${escapeHtml(result.latest || '—')}</strong></div>`
        + (result.notes ? `<div class="update-notes">${escapeHtml(result.notes)}</div>` : '');
      if (result.url) {
        $('btnUpdateOpen').hidden = false;
        $('btnUpdateOpen').onclick = () => api.openExternal(result.url);
      }
    } catch (err) {
      $('updateDesc').textContent = '检查失败';
      $('updateContent').innerHTML = `<p>${escapeHtml(err.message)}</p>`;
    }
    $('btnUpdateClose').onclick = () => modal.classList.remove('open');
    $('btnUpdateSettings').onclick = () => { modal.classList.remove('open'); openSettings(); };
    modal.onclick = (event) => { if (event.target === modal) modal.classList.remove('open'); };
  }

  // ---------- 全局搜索替换（仅替换当前文档命中的行） ----------
  function replaceCurrentFromSearch() {
    const keyword = $('globalSearchInput').value.trim();
    const replacement = $('searchReplaceInput').value;
    if (!keyword) { toast('请先输入搜索内容', 'error'); return; }
    const hits = lastSearchHits.filter((hit) => samePathKey(hit.path, state.currentFile));
    if (!hits.length) { toast('当前文档没有本轮搜索的匹配项', 'info'); return; }
    const useRegex = !!($('searchRegex') && $('searchRegex').checked);
    const caseSensitive = !!($('searchCase') && $('searchCase').checked);
    let matcher = null;
    if (useRegex) {
      try { matcher = new RegExp(keyword, caseSensitive ? 'g' : 'gi'); }
      catch (err) { toast(`正则表达式无效：${err.message}`, 'error'); return; }
    }
    const lines = editor.value.split(/\r?\n/);
    const seen = new Set();
    for (const hit of hits) {
      if (seen.has(hit.line)) continue;
      seen.add(hit.line);
      const index = hit.line - 1;
      if (index < 0 || index >= lines.length) continue;
      if (matcher) lines[index] = lines[index].replace(matcher, replacement);
      else lines[index] = lines[index].split(keyword).join(replacement);
    }
    editor.value = lines.join('\n');
    markDirty();
    toast(`已在当前文档替换 ${hits.length} 处`, 'success');
  }

  async function bootstrap() {
    try {
      perf('bootstrap start');
      if (window.MarkdownRender && window.MarkdownRender.setResourceResolver) {
        window.MarkdownRender.setResourceResolver(resolveResourceUrl);
      }
      // 公式引擎按需加载，加载完成后重绘当前文档，避免普通文档启动等待 KaTeX。
      if (window.MarkdownRender && window.MarkdownRender.onKatexReady) {
        window.MarkdownRender.onKatexReady(() => {
          renderPreview();
          perf(`katex ready (rendered=${preview.innerHTML.includes('katex')})`);
        });
      }
      state.config = await api.getConfig();
      perf('config loaded');
      renderRecentMenu();
      setClassicMenu(!!state.config.editor.classicMenu, false);
      state.fontSize = Number(state.config.editor.fontSize) || 16;
      applyFontSize();
      state.lineHeight = Number(state.config.editor.lineHeight) || 1.7;
      applyLineHeight();
      state.syntaxHighlight = state.config.editor.syntaxHighlight !== false;
      applySyntaxHighlight();
      state.theme = state.config.editor.theme === 'dark' ? 'dark' : 'light';
      const savedMood = state.config.editor.mood;
      state.mood = ['auto', 'morning', 'day', 'dusk', 'night'].includes(savedMood) ? savedMood : 'auto';
      applyTheme();
      // 时段情绪色每 5 分钟刷新一次，跨时段自动切换（手动指定时保持不变）
      setInterval(applyMood, 5 * 60 * 1000);
      setPreviewOutlineVisible(state.config.editor.previewOutline !== false, false);
      setViewMode(state.config.editor.viewMode || 'split', false);
      state.focusMode = !!state.config.editor.focusMode;
      document.body.classList.toggle('focus-mode', state.focusMode);
      state.sidebarCollapsed = !!state.config.editor.sidebarCollapsed;
      document.body.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
      state.editorFr = Number(state.config.editor.editorFr) > 0 ? Number(state.config.editor.editorFr) : 1;
      state.previewFr = Number(state.config.editor.previewFr) > 0 ? Number(state.config.editor.previewFr) : 1;
      applyLayout();

      const restored = await api.restoreWorkspace();
      if (restored) {
        state.workspace = restored;
        runWhenIdle(() => recordRecentWorkspace(restored));
        log(`已恢复上次工作区：${restored}`);
        await refreshTree();
        perf('workspace tree loaded');
      }
      // 同步当前工作区的 GitHub 配置（不同文件夹可对应不同仓库）
      try {
        if (state.config) state.config.github = (await api.getGithubConfig()) || state.config.github;
      } catch (_) { /* 读取失败时沿用默认配置 */ }
      perf('github config loaded');

      // 启动后台扫描未发布更改，给目录树打标识（有配置才会真正请求）
      if (restored) scheduleScanPublishMarks(800);

      // 恢复上次会话：重新打开上次正在编辑的文档
      let restoredCount = 0;
      try {
        restoredCount = await restoreSession();
      } catch (err) {
        log(`恢复会话失败：${err.message}`, 'error');
      }
      perf('session restored');

      // 没有恢复任何文档时，保留一个空白可编辑标签
      if (!state.tabs.length) {
        const firstTab = createTab('', '');
        state.activeTabId = firstTab.id;
      }
      const bootTab = activeTab();
      if (bootTab) {
        bindHistory(bootTab);
        editor.value = bootTab.content;
        editor.setSelectionRange(0, 0);
        editor.scrollTop = bootTab.scrollTop || 0;
        requestAnimationFrame(() => {
          gutter.scrollTop = editor.scrollTop;
          highlightLayer.scrollTop = editor.scrollTop;
        });
      }
      resetHistory(editor.value);
      updateStatus();
      updateGutter();
      updateHighlight();
      renderPreview();
      perf('preview rendered');
      renderTabs();
      restartAutoSaveTimer();
      log('知序 已就绪。', 'success');
      perf('bootstrap done');

      // 草稿恢复在空闲时检查，不阻塞首屏
      runWhenIdle(() => checkDraftRestore());

      // 取走启动时（拖放到图标 / 命令行）待打开的文件，并通知主进程渲染层已就绪
      try {
        const batches = await api.takeOpenFiles();
        for (const batch of batches || []) await openFilesFromShell(batch);
      } catch (err) {
        log(`读取启动文件失败：${err.message}`, 'error');
      }
    } catch (err) {
      log(`初始化失败：${err.message}`, 'error');
      toast(`初始化失败：${err.message}`, 'error');
    }
  }

  bindEvents();
  bootstrap();
})();
