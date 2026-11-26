'use strict';

(function (global) {
  let codeGroupCounter = 0;
  let taskLineCounter = 0;
  let resourceResolver = null;
  const taskLineMap = [];

  // KaTeX 体积较大且只有公式文档才需要：首次遇到公式时再按需加载，
  // 加载完成后通知渲染层重绘，普通文档不再为公式引擎付出解析时间。
  let katexLoading = false;
  let katexCallbacks = [];
  function katexAvailable() {
    return !!(global.katex && typeof global.katex.renderToString === 'function');
  }
  function onKatexReady(callback) {
    if (typeof callback !== 'function') return;
    if (katexAvailable()) callback();
    else katexCallbacks.push(callback);
  }
  function ensureKatex() {
    if (katexAvailable() || katexLoading) return;
    katexLoading = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'assets/katex/katex.min.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'assets/katex/katex.min.js';
    script.onload = () => {
      katexLoading = false;
      const callbacks = katexCallbacks;
      katexCallbacks = [];
      callbacks.forEach((fn) => { try { fn(); } catch (_err) { /* 单个回调失败不影响其他 */ } });
    };
    script.onerror = () => {
      katexLoading = false;
      katexCallbacks = [];
    };
    document.head.appendChild(script);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // KaTeX 公式渲染：本地脚本，离线可用；失败时降级为原样代码展示
  function renderMath(tex, display) {
    ensureKatex();
    const katex = global.katex;
    if (!katex || typeof katex.renderToString !== 'function') {
      return `<code class="math-fallback">${escapeHtml(tex)}</code>`;
    }
    try {
      return katex.renderToString(String(tex || ''), {
        displayMode: !!display,
        throwOnError: false,
        strict: false,
        trust: false,
        output: 'html'
      });
    } catch (_) {
      return `<code class="math-fallback">${escapeHtml(tex)}</code>`;
    }
  }

  // 轻量语法高亮：纯离线、无第三方依赖，按行扫描并保留 VitePress 行高亮结构
  function createHighlighter(lang) {
    const L = String(lang || '').toLowerCase();
    const isJs = /^(js|javascript|jsx|ts|typescript|tsx)$/.test(L) || L === 'vue' || L === '';
    const isPy = /^(py|python)$/.test(L);
    const isShell = /^(sh|bash|shell|zsh|console|powershell|ps1)$/.test(L);
    const isCss = /^(css|scss|sass|less|styl|stylus)$/.test(L);
    const isHtml = /^(html|htm|xml|svg)$/.test(L) || L === 'vue' || L === 'jsx' || L === 'tsx';
    const isJson = L === 'json';
    const isYaml = /^(yaml|yml)$/.test(L);
    const isSql = L === 'sql';
    const isGo = L === 'go';
    const isRust = /^(rust|rs)$/.test(L);
    const isJava = L === 'java';
    const cStyle = isJs || isGo || isRust || isJava || isCss;

    const keywords = new Set();
    const addKeywords = (words) => words.trim().split(/\s+/).forEach((word) => keywords.add(word));
    if (isJs) addKeywords('const let var function return if else for while do break continue class new import export from default async await try catch finally throw typeof instanceof void delete in of this super extends static get set yield switch case debugger interface type enum implements public private protected readonly as any string number boolean namespace declare keyof infer');
    if (isPy) addKeywords('def class return if elif else for while import from as try except finally with lambda pass break continue in not and or is self yield async await raise global nonlocal assert del');
    if (isShell) addKeywords('if then else elif fi for while do done case esac function in echo cd export source let local return exit set unset alias');
    if (isGo) addKeywords('package import func var const type struct interface map chan go defer if else return for range switch case default break continue');
    if (isRust) addKeywords('fn let mut const static struct enum impl trait match if else for while loop return use pub mod crate self super async await move ref');
    if (isJava) addKeywords('package import public private protected class interface extends implements new return if else for while do switch case default break continue static final void int long double float boolean char String this super try catch finally throw throws');
    if (isSql) addKeywords('SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER INDEX JOIN LEFT RIGHT INNER OUTER ON AS GROUP BY ORDER HAVING LIMIT OFFSET DISTINCT AND OR NOT');
    addKeywords('true false null undefined True False None NULL nil');

    let inBlockComment = false;

    function span(type, text) {
      return `<span class="tok-${type}">${escapeHtml(text)}</span>`;
    }

    function highlightLine(text) {
      const src = String(text ?? '');
      let out = '';
      let i = 0;
      while (i < src.length) {
        const rest = src.slice(i);
        if (inBlockComment) {
          const end = rest.indexOf('*/');
          if (end === -1) { out += span('comment', rest); i = src.length; }
          else { out += span('comment', rest.slice(0, end + 2)); i += end + 2; inBlockComment = false; }
          continue;
        }
        const ws = rest.match(/^\s+/);
        if (ws) { out += escapeHtml(ws[0]); i += ws[0].length; continue; }
        if (cStyle && rest.startsWith('/*')) { inBlockComment = true; out += span('comment', '/*'); i += 2; continue; }
        if ((isJs || isGo || isRust || isJava || isCss) && rest.startsWith('//')) { out += span('comment', rest); break; }
        if ((isPy || isShell || isYaml) && rest.startsWith('#')) { out += span('comment', rest); break; }
        if (isSql && /^--/.test(rest)) { out += span('comment', rest); break; }
        const strMatch = rest.match(/^"(?:\\.|[^"\\])*"?|^'(?:\\.|[^'\\])*'?|^`(?:\\.|[^`\\])*`?/);
        if (strMatch) {
          const value = strMatch[0];
          out += span(isJson && /^"[^"]*"\s*:/.test(rest) ? 'attr' : 'string', value);
          i += value.length; continue;
        }
        const numMatch = rest.match(/^(?:0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
        if (numMatch) { out += span('number', numMatch[0]); i += numMatch[0].length; continue; }
        if (isHtml) {
          const tagMatch = rest.match(/^<\/?[A-Za-z][\w:-]*/);
          if (tagMatch) { out += span('tag', tagMatch[0]); i += tagMatch[0].length; continue; }
        }
        if (isCss) {
          const propMatch = rest.match(/^[a-zA-Z-]+(?=\s*:)/);
          if (propMatch) { out += span('attr', propMatch[0]); i += propMatch[0].length; continue; }
          const selMatch = rest.match(/^[.#][A-Za-z_][\w-]*/);
          if (selMatch) { out += span('selector', selMatch[0]); i += selMatch[0].length; continue; }
        }
        if (isYaml) {
          const keyMatch = rest.match(/^[A-Za-z_][\w.-]*(?=\s*:)/);
          if (keyMatch) { out += span('attr', keyMatch[0]); i += keyMatch[0].length; continue; }
        }
        if (isShell) {
          const varMatch = rest.match(/^\$\{?[\w]+\}?/);
          if (varMatch) { out += span('variable', varMatch[0]); i += varMatch[0].length; continue; }
        }
        const identMatch = rest.match(/^[A-Za-z_$][\w$]*/);
        if (identMatch) {
          const value = identMatch[0];
          const key = isSql ? value.toUpperCase() : value;
          let type = '';
          if (keywords.has(key)) type = 'keyword';
          else if (/^\s*\(/.test(src.slice(i + value.length))) type = 'func';
          else if (/^(true|false|null|undefined|True|False|None|NULL|nil)$/.test(value)) type = 'literal';
          out += type ? span(type, value) : escapeHtml(value);
          i += value.length; continue;
        }
        out += escapeHtml(src[i]); i += 1;
      }
      return out;
    }
    return { line: highlightLine };
  }

  function safeUrl(raw) {
    const url = String(raw || '').trim();
    if (/^(javascript|vbscript|file|data:text\/html):/i.test(url)) return '#';
    return url;
  }

  function setResourceResolver(fn) {
    resourceResolver = typeof fn === 'function' ? fn : null;
  }

  // 图片专用：先按当前文档目录解析相对路径，再安全校验；允许本地 file:// 图片
  function safeImageUrl(raw) {
    const original = String(raw || '').trim();
    const resolved = resourceResolver ? resourceResolver(original) : original;
    if (/^file:\/\//i.test(resolved)) return resolved;
    return safeUrl(resolved);
  }

  function stripInline(text) {
    return String(text ?? '')
      // 新版：内联 HTML 标签（span/mark/u/div 等）整体剥离
      .replace(/<\/?[a-z][^>]*>/gi, '')
      // 兼容旧版自研扩展语法
      .replace(/\{color:[^}]+\}/g, '')
      .replace(/\{bg:[^}]+\}/g, '')
      .replace(/\{grad:[^}]+\}/g, '')
      .replace(/\{align:[^}]+\}/g, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/==#[0-9a-fA-F]{3,8}\|([^=]+)==/g, '$1')
      .replace(/==([^=]+)==/g, '$1')
      .replace(/\+\+([^+]+)\+\+/g, '$1')
      .replace(/\{#[^\s}]+\}\s*$/g, '')
      .replace(/[*_~`]/g, '')
      .trim();
  }

  // VitePress / GitHub 支持的 Emoji 缩写子集（预览与发布保持一致）
  const EMOJI = {
    smile: '😄', smiley: '😃', grinning: '😀', joy: '😂', laughing: '😆', wink: '😉',
    blush: '😊', heart_eyes: '😍', thinking: '🤔', sleeping: '😴', cry: '😢', sob: '😭',
    angry: '😠', rage: '😡', cool: '😎', relieved: '😌', pray: '🙏', clap: '👏',
    thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', ok_hand: '👌', wave: '👋',
    heart: '❤️', blue_heart: '💙', green_heart: '💚', sparkling_heart: '💖', fire: '🔥',
    star: '⭐', sparkles: '✨', tada: '🎉', confetti_ball: '🎊', rocket: '🚀', bulb: '💡',
    warning: '⚠️', heavy_check_mark: '✔️', white_check_mark: '✅', x: '❌',
    heavy_multiplication_x: '✖️', question: '❓', exclamation: '❗', info: 'ℹ️',
    book: '📖', memo: '📝', pushpin: '📌', link: '🔗', lock: '🔒', key: '🔑',
    computer: '💻', iphone: '📱', email: '📧', package: '📦', hammer: '🔨', wrench: '🔧',
    bug: '🐛', warning_sign: '🚧', construction: '🚧', checkered_flag: '🏁',
    green_circle: '🟢', yellow_circle: '🟡', red_circle: '🔴', arrow_right: '➡️',
    arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', 100: '💯', shipit: '🚢'
  };

  // 提取标题中的自定义锚点 {#id}，返回 { text, id }
  function splitHeadingId(raw) {
    const match = String(raw || '').match(/\{#([^\s}]+)\}\s*$/);
    if (!match) return { text: String(raw || ''), id: '' };
    return { text: String(raw).slice(0, match.index), id: match[1] };
  }

  // 方案2：编辑器直接写入内联 HTML。预览时只放行一个安全白名单内的行内标签，
  // 并剔除事件属性与 javascript: 协议，避免本地文档通过 innerHTML 注入脚本。
  const INLINE_HTML_TAG = /<\/?(span|mark|u|div|br|strong|em|b|i|sub|sup|small)\b[^>]*>/gi;

  function sanitizeInlineTag(tag) {
    return String(tag)
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/expression\s*\(/gi, '');
  }

  function slugify(text) {
    return stripInline(text)
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  }

  function extractFrontmatter(lines) {
    if (!lines.length || lines[0].trim() !== '---') return lines;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') return lines.slice(i + 1);
    }
    return lines;
  }

  function collectHeadings(lines) {
    const headings = [];
    let inFence = false;
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        const parts = splitHeadingId(match[2]);
        const text = stripInline(parts.text);
        headings.push({ level: match[1].length, text, id: parts.id || slugify(text), line: index });
      }
    });
    return headings;
  }

  function splitTableRow(line) {
    return String(line)
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function tableAlignment(line) {
    if (!line || !line.includes('|')) return null;
    const cells = splitTableRow(line);
    if (!cells.length) return null;
    return cells.map((cell) => {
      if (!/^:?-{3,}:?$/.test(cell)) return null;
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
  }

  function renderToc(headings) {
    const items = headings.filter((heading) => heading.level <= 3);
    if (!items.length) return '<div class="vp-toc"><div class="vp-toc-title">目录</div><span>暂无标题</span></div>';
    const links = items
      .map((heading) => `<a class="vp-toc-level-${heading.level}" href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`)
      .join('');
    return `<div class="vp-toc"><div class="vp-toc-title">目录</div>${links}</div>`;
  }

  function inline(raw) {
    const codeTokens = [];
    const htmlTokens = [];
    const mathTokens = [];
    let s = String(raw ?? '');

    // 先把白名单内联 HTML 标签抽成占位符，避免被下面的 escapeHtml 转义；
    // 代码块（反引号）里的同名标签不应被渲染，因此先保护行内代码。
    s = s.replace(/`([^`\n]+)`/g, (_match, code) => {
      const token = `\u0003${codeTokens.length}\u0003`;
      codeTokens.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
      return token;
    });
    // 行内公式 $...$：在转义/标签处理前抽成占位符，避免 LaTeX 里的 \ < & 被破坏
    s = s.replace(/\$([^$\n]+)\$/g, (_match, tex) => {
      const token = `\u0005${mathTokens.length}\u0005`;
      mathTokens.push(renderMath(tex, false));
      return token;
    });
    s = s.replace(INLINE_HTML_TAG, (tag) => {
      const token = `\u0004${htmlTokens.length}\u0004`;
      htmlTokens.push(sanitizeInlineTag(tag));
      return token;
    });

    s = escapeHtml(s);

    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_match, alt, url) => `<img src="${safeImageUrl(url)}" alt="${alt || ''}">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_match, text, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noreferrer">${text}</a>`);

    // Emoji 缩写：:smile: → 😄（VitePress 默认支持）
    s = s.replace(/:([a-z0-9_+-]+):/gi, (match, name) => EMOJI[name.toLowerCase()] || match);

    // 背景高亮：==文字== 默认黄色；==#hex|文字== / {bg:#hex|文字} 自定义色
    s = s.replace(/==(#[0-9a-fA-F]{3,8})\|([^=\n]+)==/g, '<mark style="background:$1">$2</mark>');
    s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    s = s.replace(/\{bg:(#[0-9a-fA-F]{3,8})\|([^}\n]+)\}/g, '<mark style="background:$1">$2</mark>');
    s = s.replace(/\+\+([^+]+)\+\+/g, '<u>$1</u>');
    // 渐变文字色：{grad:#hex1,#hex2|文字}
    s = s.replace(/\{grad:(#[0-9a-fA-F]{3,8},#[0-9a-fA-F]{3,8})\|([^}\n]+)\}/g,
      (_m, pair, text) => `<span class="md-gradient-text" style="background-image:linear-gradient(135deg,${pair});color:transparent">${text}</span>`);
    s = s.replace(/\{color:(#[0-9a-fA-F]{3,8})\|([^}\n]+)\}/g, '<span style="color:$1">$2</span>');
    s = s.replace(/\{align:(left|center|right|justify)\|([^}\n]+)\}/g, '<div style="text-align:$1">$2</div>');

    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // 上标 ^文字^ / 下标 ~文字~：注意删除线已先处理，这里匹配单个波浪号包裹
    s = s.replace(/\^([^\^\n]+)\^/g, '<sup>$1</sup>');
    s = s.replace(/(^|[^~])~([^~\n]+)~(?!~)/g, '$1<sub>$2</sub>');

    codeTokens.forEach((html, index) => {
      s = s.split(`\u0003${index}\u0003`).join(html);
    });
    htmlTokens.forEach((html, index) => {
      s = s.split(`\u0004${index}\u0004`).join(html);
    });
    mathTokens.forEach((html, index) => {
      s = s.split(`\u0005${index}\u0005`).join(html);
    });
    return s;
  }

  function parseCodeInfo(info) {
    let rest = String(info || '').trim();
    const languageMatch = rest.match(/^([\w+#.-]*)/);
    const lang = languageMatch ? languageMatch[1] : '';
    rest = languageMatch ? rest.slice(lang.length) : rest;

    let highlight = '';
    rest = rest.replace(/\{([^}]*)\}/, (_match, spec) => {
      highlight = spec.trim();
      return ' ';
    });

    let title = '';
    const titleMatch = rest.match(/title="([^"]+)"/) || rest.match(/\[([^\]]+)\]/);
    if (titleMatch) title = titleMatch[1];

    return { lang, highlight, title };
  }

  function highlightedLines(spec, total) {
    const result = new Set();
    if (!spec) return result;
    spec.split(',').forEach((part) => {
      const value = part.trim();
      if (!value) return;
      if (/^\d+$/.test(value)) {
        const line = Number(value);
        if (line >= 1 && line <= total) result.add(line);
      } else {
        const range = value.match(/^(\d+)-(\d+)$/);
        if (range) {
          const start = Number(range[1]);
          const end = Number(range[2]);
          for (let line = start; line <= Math.min(end, total); line += 1) result.add(line);
        }
      }
    });
    return result;
  }

  function buildCodeHtml(lang, highlight, title, codeLines) {
    const activeLines = highlightedLines(highlight, codeLines.length);
    const highlighter = createHighlighter(lang);
    const body = codeLines
      .map((line, index) => `<span class="vp-line${activeLines.has(index + 1) ? ' highlighted' : ''}">${highlighter.line(line) || ' '}</span>`)
      .join('');
    const attr = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
    const head = title ? `<div class="vp-code-title">${escapeHtml(title)}</div>` : '';
    return `${head}<pre><code${attr}>${body}</code></pre>`;
  }

  function renderCodeGroup(innerLines) {
    const blocks = [];
    let index = 0;
    while (index < innerLines.length) {
      const fence = innerLines[index].match(/^```(.*)$/);
      if (fence) {
        const info = parseCodeInfo(fence[1]);
        const codeLines = [];
        index += 1;
        while (index < innerLines.length && !/^```\s*$/.test(innerLines[index])) {
          codeLines.push(innerLines[index]);
          index += 1;
        }
        const title = info.title || `代码 ${blocks.length + 1}`;
        blocks.push({
          title,
          html: buildCodeHtml(info.lang, info.highlight, title, codeLines)
        });
      }
      index += 1;
    }

    const groupId = `code-group-${codeGroupCounter += 1}`;
    const tabs = blocks.map((block, tabIndex) =>
      `<button type="button" class="vp-code-tab${tabIndex === 0 ? ' active' : ''}" data-group="${groupId}" data-index="${tabIndex}">${escapeHtml(block.title)}</button>`
    ).join('');
    const panels = blocks.map((block, panelIndex) =>
      `<div class="vp-code-panel${panelIndex === 0 ? ' active' : ''}" data-group="${groupId}" data-index="${panelIndex}">${block.html}</div>`
    ).join('');

    return `<div class="vp-code-group" data-group="${groupId}"><div class="vp-code-tabs">${tabs}</div><div class="vp-code-panels">${panels}</div></div>`;
  }

  // GitHub 风格 Alert：> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
  const GITHUB_ALERTS = {
    note: { type: 'info', label: '说明', icon: 'ℹ️' },
    tip: { type: 'tip', label: '提示', icon: '💡' },
    important: { type: 'tip', label: '重要', icon: '❗' },
    warning: { type: 'warning', label: '警告', icon: '⚠️' },
    caution: { type: 'danger', label: '注意', icon: '🚨' }
  };

  function renderGithubAlert(kind, innerLines) {
    const meta = GITHUB_ALERTS[kind] || GITHUB_ALERTS.note;
    const content = render(innerLines.join('\n'), false);
    return `<div class="vp-admonition ${meta.type} github-alert"><div class="vp-admonition-title"><span class="vp-admonition-badge">${meta.icon} ${meta.label}</span></div><div class="vp-admonition-content">${content}</div></div>`;
  }

  function renderAdmonition(type, title, innerLines) {
    if (type === 'code-group') return renderCodeGroup(innerLines);
    if (type === 'raw') return innerLines.join('\n');

    const content = render(innerLines.join('\n'), false);
    const defaults = {
      tip: '提示',
      info: '信息',
      warning: '注意',
      danger: '警告',
      details: '详情'
    };
    const label = title || defaults[type] || type;

    if (type === 'details') {
      return `<details class="vp-details"><summary>${inline(label)}</summary><div class="vp-details-content">${content}</div></details>`;
    }

    const badge = escapeHtml(type.toUpperCase());
    return `<div class="vp-admonition ${escapeHtml(type)}"><div class="vp-admonition-title"><span class="vp-admonition-badge">${badge}</span>${inline(label)}</div><div class="vp-admonition-content">${content}</div></div>`;
  }

  function render(source, isRoot = true) {
    const normalized = String(source ?? '').replace(/\r\n?/g, '\n');
    let lines = normalized.split('\n');
    let frontmatterOffset = 0;
    if (isRoot && extractFrontmatter(lines) !== lines) {
      // extractFrontmatter 移除的行数 = 原始行数 - 移除后行数
      frontmatterOffset = lines.length - extractFrontmatter(lines).length;
    }
    if (isRoot) {
      taskLineMap.length = 0;
      taskLineCounter = 0;
      lines = extractFrontmatter(lines);
    }
    const headings = collectHeadings(lines);

    const out = [];
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
      paragraph = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (!line.trim()) {
        flushParagraph();
        continue;
      }

      if (/^\s*\[\[toc\]\]\s*$/i.test(line)) {
        flushParagraph();
        out.push(renderToc(headings));
        continue;
      }

      if (/^:::\s*$/.test(line)) {
        flushParagraph();
        continue;
      }

      const containerMatch = line.match(/^:::\s*([\w-]*)\s*(.*)$/);
      if (containerMatch) {
        flushParagraph();
        const type = (containerMatch[1] || 'tip').toLowerCase();
        const title = containerMatch[2] || '';
        const innerLines = [];
        i += 1;
        while (i < lines.length && !/^:::\s*$/.test(lines[i])) {
          innerLines.push(lines[i]);
          i += 1;
        }
        out.push(renderAdmonition(type, title, innerLines));
        continue;
      }

      const fence = line.match(/^```([\w+#.-]*)(.*)$/);
      if (fence) {
        flushParagraph();
        const info = parseCodeInfo(fence[1] + fence[2]);
        const codeLines = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        out.push(buildCodeHtml(info.lang, info.highlight, info.title, codeLines));
        continue;
      }

      // 公式块：$$...$$（单行闭合 或 独占一行的 $$ 围栏）
      if (/^\s*\$\$\s*\S/.test(line)) {
        flushParagraph();
        const single = line.match(/^\s*\$\$(.+?)\$\$\s*$/);
        if (single) {
          out.push(`<div class="md-math-block">${renderMath(single[1].trim(), true)}</div>`);
          continue;
        }
        const texLines = [line.replace(/^\s*\$\$\s*/, '')];
        i += 1;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
          texLines.push(lines[i]);
          i += 1;
        }
        out.push(`<div class="md-math-block">${renderMath(texLines.join('\n').trim(), true)}</div>`);
        continue;
      }
      if (/^\s*\$\$\s*$/.test(line)) {
        flushParagraph();
        const texLines = [];
        i += 1;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
          texLines.push(lines[i]);
          i += 1;
        }
        out.push(`<div class="md-math-block">${renderMath(texLines.join('\n').trim(), true)}</div>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        const parts = splitHeadingId(heading[2]);
        const id = parts.id || slugify(parts.text);
        out.push(`<h${level} id="${escapeHtml(id)}">${inline(parts.text)}</h${level}>`);
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        out.push('<hr>');
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        i -= 1;
        // GitHub Alert：引用块首行是 [!NOTE] 等标记时渲染为提示框
        const alertMatch = quoteLines[0] && quoteLines[0].trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
        if (alertMatch) {
          out.push(renderGithubAlert(alertMatch[1].toLowerCase(), quoteLines.slice(1)));
        } else {
          out.push(`<blockquote>${quoteLines.map(inline).join('<br>')}</blockquote>`);
        }
        continue;
      }

      // GFM / VitePress 表格：表头行 + 分隔行 + 若干数据行
      if (line.includes('|') && i + 1 < lines.length) {
        const alignments = tableAlignment(lines[i + 1]);
        if (alignments) {
          flushParagraph();
          const headers = splitTableRow(line);
          const alignStyle = (index) => {
            const value = alignments[index];
            return value ? ` style="text-align:${value}"` : '';
          };
          const head = headers
            .map((cell, index) => `<th${alignStyle(index)}>${inline(cell)}</th>`)
            .join('');
          const bodyRows = [];
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
            const cells = splitTableRow(lines[i]);
            const normalized = headers.map((_header, index) => cells[index] ?? '');
            bodyRows.push(`<tr>${normalized.map((cell, index) => `<td${alignStyle(index)}>${inline(cell)}</td>`).join('')}</tr>`);
            i += 1;
          }
          i -= 1;
          out.push(`<table><thead><tr>${head}</tr></thead><tbody>${bodyRows.join('')}</tbody></table>`);
          continue;
        }
      }

      const isTask = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.test(line);
      const isUl = /^\s*[-*+]\s+(.*)$/.test(line);
      const isOl = /^\s*\d+[.)]\s+(.*)$/.test(line);

      if (isTask || isUl || isOl) {
        flushParagraph();
        const mode = isTask ? 'task' : (isUl ? 'ul' : 'ol');
        const items = [];
        while (i < lines.length) {
          const current = lines[i];
          let match = null;
          if (mode === 'task') {
            match = current.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
            if (match) {
              const taskId = taskLineCounter++;
              taskLineMap[taskId] = i + frontmatterOffset;
              items.push(`<li class="task"><input type="checkbox" data-task="${taskId}" ${match[1].toLowerCase() === 'x' ? 'checked' : ''}> <span>${inline(match[2])}</span></li>`);
            }
          } else if (mode === 'ul') {
            match = current.match(/^\s*[-*+]\s+(.*)$/);
            if (match) items.push(`<li>${inline(match[1])}</li>`);
          } else {
            match = current.match(/^\s*\d+[.)]\s+(.*)$/);
            if (match) items.push(`<li>${inline(match[1])}</li>`);
          }
          if (!match) break;
          i += 1;
        }
        i -= 1;
        const tag = mode === 'task' ? 'ul' : mode;
        out.push(`<${tag} class="md-list">${items.join('')}</${tag}>`);
        continue;
      }

      paragraph.push(line);
    }

    flushParagraph();
    return out.join('\n');
  }

  global.MarkdownRender = {
    render,
    inline,
    escapeHtml,
    setResourceResolver,
    onKatexReady,
    createHighlighter,
    parseCodeInfo,
    // 大纲面板：解析标题（跳过 frontmatter 与代码块），返回 { level, text, id, line }
    getHeadings: (source) => {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
      const body = extractFrontmatter(lines);
      const offset = lines.length - body.length;
      return collectHeadings(body).map((heading) => ({ ...heading, line: heading.line + offset }));
    },
    getTaskLine: (id) => taskLineMap[Number(id)]
  };
})(window);
