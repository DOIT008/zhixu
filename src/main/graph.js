'use strict';

// 文档关系图谱：从 Markdown 内链构建节点与边，供渲染层绘制。
// 不依赖第三方库，保持启动与调用轻量。

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');

const SKIP_LINK = /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i;
const ASSET_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|pdf)$/i;

function stripCodeAndFrontmatter(text) {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/```[\s\S]*?```/g, '');
}

function resolveTarget(raw, sourceRel, docsByRel) {
  let target = String(raw || '').trim().split(/\s+/)[0].replace(/^<|>$/g, '');
  if (!target || SKIP_LINK.test(target)) return null;
  try { target = decodeURIComponent(target.split('#')[0].split('?')[0]); } catch (_err) { /* 保留原值 */ }
  if (!target || ASSET_RE.test(target)) return null;

  const base = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(sourceRel), target);
  const normalized = path.posix.normalize(base).replace(/^\.\//, '');
  const variants = [normalized, `${normalized}.md`, `${normalized}.mdx`, path.posix.join(normalized, 'index.md')];
  return variants.find((item) => docsByRel.has(item)) || null;
}

function build() {
  const ws = workspace.getWorkspace();
  if (!ws) throw new Error('请先选择工作区文件夹。');

  const files = workspace.listMarkdownFiles();
  const docs = [];
  for (const file of files) {
    try {
      docs.push({ ...file, content: fs.readFileSync(file.path, 'utf8') });
    } catch (_err) { /* 忽略读取失败的文件 */ }
  }

  const docsByRel = new Map(docs.map((doc) => [doc.relative, doc]));
  const nodes = docs.map((doc) => ({
    id: doc.relative,
    // 绝对路径：渲染层点击节点时直接用它打开文件，避免相对路径被解析到进程 cwd 导致 ENOENT
    filePath: doc.path,
    name: path.basename(doc.relative, path.extname(doc.relative)),
    dir: path.posix.dirname(doc.relative) === '.' ? '/' : path.posix.dirname(doc.relative),
    inDegree: 0,
    outDegree: 0,
    isolated: false
  }));
  const links = [];
  const seen = new Set();

  for (const doc of docs) {
    const body = stripCodeAndFrontmatter(doc.content);
    const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = re.exec(body))) {
      const target = resolveTarget(match[1], doc.relative, docsByRel);
      if (!target || target === doc.relative) continue;
      const key = `${doc.relative}=>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: doc.relative, target });
    }
  }

  for (const link of links) {
    const source = nodes.find((node) => node.id === link.source);
    const target = nodes.find((node) => node.id === link.target);
    if (source) source.outDegree += 1;
    if (target) target.inDegree += 1;
  }
  for (const node of nodes) node.isolated = node.inDegree === 0 && node.outDegree === 0;

  return {
    workspace: ws,
    nodes,
    links,
    stats: {
      documents: nodes.length,
      links: links.length,
      isolated: nodes.filter((node) => node.isolated).length,
      hubs: nodes.slice().sort((a, b) => b.inDegree - a.inDegree).slice(0, 8)
    }
  };
}

module.exports = { build };
