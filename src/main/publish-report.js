'use strict';

// 发布前体检：把链接、图片、文档结构、配置等检查汇总成一份报告。
// 只读工作区，不自动修改任何文件。

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');
const config = require('./config');

const SKIP_LINK = /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i;

function relOf(full) {
  const ws = workspace.getWorkspace();
  return ws ? path.relative(ws, full).split(path.sep).join('/') : path.basename(full);
}

function readDocs() {
  const files = workspace.listMarkdownFiles();
  const docs = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      docs.push({ ...file, content, lines: content.split(/\r?\n/) });
    } catch (_err) { /* 忽略读取失败的文档 */ }
  }
  return docs;
}

function stripCodeAndFrontmatter(text) {
  const withoutFm = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return withoutFm.replace(/```[\s\S]*?```/g, '');
}

function collectOutlinks(doc, docsByRel) {
  const targets = [];
  const body = stripCodeAndFrontmatter(doc.content);
  const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(body))) {
    const raw = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '');
    if (!raw || SKIP_LINK.test(raw)) continue;
    const clean = decodeURIComponent(raw.split('#')[0].split('?')[0]);
    if (!clean || /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|pdf)$/i.test(clean)) continue;
    let candidate = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(doc.relative), clean);
    candidate = path.posix.normalize(candidate);
    const variants = [candidate, `${candidate}.md`, `${candidate}.mdx`, path.posix.join(candidate, 'index.md')];
    const found = variants.find((v) => docsByRel.has(v.replace(/^\.\//, '')));
    if (found) targets.push(found.replace(/^\.\//, ''));
  }
  return targets;
}

function frontmatterTitle(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find((item) => /^title\s*:/i.test(item));
  if (!line) return null;
  return line.replace(/^title\s*:\s*/i, '').trim().replace(/^["']|["']$/g, '');
}

function duplicateTitles(docs) {
  const groups = new Map();
  for (const doc of docs) {
    const h1 = doc.lines.map((line) => line.match(/^#\s+(.+?)\s*$/)).find(Boolean);
    const title = frontmatterTitle(doc.content) || (h1 && h1[1]) || path.basename(doc.relative, path.extname(doc.relative));
    const key = String(title).trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ doc, title });
  }
  return [...groups.entries()].filter(([, items]) => items.length > 1).map(([key, items]) => ({ key, items }));
}

function run() {
  const ws = workspace.getWorkspace();
  if (!ws) throw new Error('请先选择工作区文件夹。');

  const items = [];
  const add = (level, category, message, file, line, fixHint) => {
    items.push({ level, category, message, file: file || '', line: line || 0, fixHint: fixHint || '' });
  };

  const docs = readDocs();
  const docsByRel = new Map(docs.map((doc) => [doc.relative, doc]));
  const inbound = new Map();

  for (const doc of docs) {
    for (const target of collectOutlinks(doc, docsByRel)) {
      inbound.set(target, (inbound.get(target) || 0) + 1);
    }
  }

  // 1. 链接与图片引用（复用已有体检逻辑，避免两套规则出现偏差）
  try {
    const linkResult = workspace.checkLinks();
    for (const issue of (linkResult && linkResult.issues) || []) {
      const label = issue.image ? '失效图片' : '失效链接';
      add('error', label, `${issue.relative || relOf(issue.file)} 引用了不存在的 ${issue.target}`, issue.file || '', Number(issue.line) || 0, '检查目标文件或图片是否已删除/改名');
    }
  } catch (err) {
    add('warning', '链接体检', `链接扫描失败：${err.message}`, '', 0, '稍后重试');
  }

  // 2. 孤立文档（没有任何文档链入；首页/README 豁免）
  for (const doc of docs) {
    const base = path.basename(doc.relative).toLowerCase();
    if (/^(index|readme)\.mdx?$/.test(base)) continue;
    if (!inbound.get(doc.relative)) {
      add('info', '孤立文档', `${doc.relative} 没有被其他文档引用`, doc.relative, 0, '可在目录页增加链接，避免知识库中出现孤岛');
    }
  }

  // 3. 重复标题
  for (const group of duplicateTitles(docs)) {
    const files = group.items.map((item) => item.doc.relative).join('、');
    for (const item of group.items) {
      add('warning', '重复标题', `标题「${item.title}」与 ${files} 重复`, item.doc.relative, 0, 'VitePress 侧边栏同名条目容易混淆，建议改标题');
    }
  }

  // 4. Frontmatter 完整性（提示级，不阻塞发布）
  for (const doc of docs) {
    const title = frontmatterTitle(doc.content);
    if (!title) {
      add('info', '元信息', `${doc.relative} 缺少 frontmatter title，将使用文件名作为标题`, doc.relative, 0, '可在「文档元信息」中补充 title 与 description');
    }
  }

  // 5. 大图提醒
  for (const image of workspace.listImageFiles()) {
    if (image.size > 2 * 1024 * 1024) {
      add('info', '大图提醒', `${image.relative} 超过 2MB（${Math.round(image.size / 1024 / 1024)}MB）`, image.relative, 0, '建议压缩后再发布，避免站点加载变慢');
    }
  }

  // 6. 发布配置检查
  const gh = config.getGithubForWorkspace(ws).github || {};
  if (!gh.owner || !gh.repo) add('error', '发布配置', '当前工作区未配置 GitHub owner/repo', '', 0, '打开设置 → GitHub 发布补全仓库信息');
  if (!gh.token) add('error', '发布配置', '未配置 GitHub Token', '', 0, '打开设置 → GitHub 发布填写具备 Contents 写权限的 Token');
  if (!gh.pathPrefix) add('warning', '发布配置', '未设置仓库内目标目录，默认使用 docs', '', 0, '确认 VitePress 文档目录后补全 pathPrefix');

  // 7. VitePress 配置存在性
  const vpDir = path.join(ws, '.vitepress');
  const hasConfig = ['.vitepress/config.mts', '.vitepress/config.ts', '.vitepress/config.js', '.vitepress/config.mjs']
    .some((rel) => fs.existsSync(path.join(ws, rel)));
  if (!hasConfig) add('warning', '站点结构', '当前工作区未发现 .vitepress/config.*', '', 0, '确认发布目标是否为 VitePress 站点');

  // 信息项过多时只保留前 40 条，错误与警告全部保留
  const errors = items.filter((item) => item.level === 'error');
  const warnings = items.filter((item) => item.level === 'warning');
  const infos = items.filter((item) => item.level === 'info').slice(0, 40);

  return {
    workspace: ws,
    scanned: docs.length,
    items: [...errors, ...warnings, ...infos],
    summary: {
      error: errors.length,
      warning: warnings.length,
      info: items.filter((item) => item.level === 'info').length,
      shownInfo: infos.length
    },
    generatedAt: Date.now()
  };
}

module.exports = { run };
