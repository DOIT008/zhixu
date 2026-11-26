'use strict';

// 让 VitePress 的静态 sidebar 配置跟随本地 Markdown 文档变化：
// - 新增文档 → 插入缺失项
// - 删除文档 → 移除失效条目
// - 改名文档 → 旧条目移除、新条目插入
// 不重写现有分组、顺序或自定义结构，尽量减少对站点配置的侵入。

const fs = require('fs');
const path = require('path');

const CONFIG_NAMES = ['config.mts', 'config.ts', 'config.mjs', 'config.js'];
const MD_RE = /\.(md|markdown|mdx)$/i;

// 兼容尚未迁移目录名的语雀仓库：目录名是语雀导出的 ID 时显示中文分组名。
// 目录已改为中文名后这里不会命中，界面直接显示真实目录名。
const YUQUE_FOLDER_LABELS = {
  '24013644-nmkii5': '工作',
  '44851824-qmvy1p': '生活',
  '44851988-rs8s8g': '前端',
  '48466893-qd0t47': '开源',
  '58796906-gzq3v8': 'Python'
};

function findConfigFile(workspace) {
  if (!workspace) return null;
  for (const name of CONFIG_NAMES) {
    const file = path.join(workspace, '.vitepress', name);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch (_) { /* 继续找下一个 */ }
  }
  return null;
}

// 返回从 start 开始、与 start 处括号配对的结束位置；跳过字符串和注释。
function scanBalanced(text, start, open, close) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function normalizeLink(value) {
  let link = String(value || '').trim().split(/[?#]/)[0];
  try { link = decodeURIComponent(link); } catch (_) { /* 保留原值 */ }
  return link.replace(/^\/+|\/+$/g, '').toLowerCase();
}

function firstSegment(link) {
  return normalizeLink(link).split('/')[0] || '';
}

function quote(value) {
  return JSON.stringify(String(value));
}

// 收集一个 items 数组里所有带 link 的条目（含嵌套分组内部的条目），记录可精确删除的位置。
function readItemEntries(source, itemsOpen, itemsClose) {
  const entries = [];
  let cursor = itemsOpen + 1;
  while (cursor < itemsClose) {
    if (source[cursor] === '{') {
      const end = scanBalanced(source, cursor, '{', '}');
      if (end < 0 || end > itemsClose) break;
      const body = source.slice(cursor, end + 1);
      const linkMatch = /\blink\s*:\s*(['"])([\s\S]*?)\1/.exec(body);
      const nested = /\bitems\s*:/.test(body);
      if (linkMatch && !nested) {
        entries.push({ start: cursor, end, link: normalizeLink(linkMatch[2]) });
      }
      // 嵌套分组本身没有 link，继续往里扫描它的 items，不要整块跳过
      cursor = nested ? cursor + 1 : end + 1;
      continue;
    }
    cursor += 1;
  }
  return entries;
}

function readGroups(source, arrayStart, arrayEnd) {
  const groups = [];
  let cursor = arrayStart + 1;
  while (cursor < arrayEnd) {
    const ch = source[cursor];
    if (ch === '{') {
      const end = scanBalanced(source, cursor, '{', '}');
      if (end < 0 || end > arrayEnd) break;
      const body = source.slice(cursor, end + 1);
      const textMatch = /\btext\s*:\s*(['"])([\s\S]*?)\1/.exec(body);
      const itemsMatch = /\bitems\s*:\s*\[/.exec(body);
      if (textMatch && itemsMatch) {
        const itemsOpen = cursor + itemsMatch.index + itemsMatch[0].lastIndexOf('[');
        const itemsClose = scanBalanced(source, itemsOpen, '[', ']');
        if (itemsClose > itemsOpen && itemsClose <= end) {
          const links = new Set();
          const re = /\blink\s*:\s*(['"])([\s\S]*?)\1/g;
          let match;
          while ((match = re.exec(body))) links.add(normalizeLink(match[2]));
          groups.push({
            start: cursor,
            end,
            label: textMatch[2],
            itemsOpen,
            itemsClose,
            links,
            entries: readItemEntries(source, itemsOpen, itemsClose)
          });
        }
      }
      cursor = end + 1;
      continue;
    }
    cursor += 1;
  }
  return groups;
}

function parseSidebar(text) {
  const key = /\bsidebar\s*:\s*\[/.exec(text);
  if (!key) return null;
  const arrayStart = key.index + key[0].lastIndexOf('[');
  const arrayEnd = scanBalanced(text, arrayStart, '[', ']');
  if (arrayEnd < 0) return null;
  const groups = readGroups(text, arrayStart, arrayEnd);
  if (!groups.length) return null;
  return { arrayStart, arrayEnd, groups };
}

function insertionIndent(source, position, fallback) {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1;
  const line = source.slice(lineStart, position);
  const match = /^[ \t]*/.exec(line);
  return match && match[0] ? match[0] : fallback;
}

function itemIndent(source, itemsOpen, itemsClose, fallback) {
  const body = source.slice(itemsOpen + 1, itemsClose);
  const match = /\n([ \t]+)\S/.exec(body);
  return match ? match[1] : fallback;
}

function stripPublishPrefix(relative, prefix) {
  const rel = normalizeRel(relative);
  const pre = normalizeRel(prefix);
  if (pre && (rel === pre || rel.startsWith(pre + '/'))) return rel.slice(pre.length + 1);
  return rel;
}

function syncSidebar({ workspace, files, pathPrefix, extraFolders, logger } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const configFile = findConfigFile(workspace);
  if (!configFile) return null;

  let source;
  try { source = fs.readFileSync(configFile, 'utf8'); } catch (_) { return null; }
  const parsed = parseSidebar(source);
  if (!parsed) return null;

  // 本地文档索引：工作区可能是 docs 根目录，也可能是仓库根目录（此时用 pathPrefix 去掉 docs/）
  const localLinks = new Set();
  const localDocs = [];
  for (const file of (Array.isArray(files) ? files : [])) {
    const relative = stripPublishPrefix(file && file.relative, pathPrefix);
    if (!MD_RE.test(relative)) continue;
    const withoutExt = relative.replace(MD_RE, '');
    // 根目录散落的临时文档、README 与首页不自动进入侧边栏
    if (!withoutExt || !withoutExt.includes('/') || /(^|\/)(index|readme)$/i.test(withoutExt)) continue;
    const link = normalizeLink('/' + withoutExt);
    localLinks.add(link);
    localDocs.push({ name: path.basename(withoutExt), link: '/' + withoutExt, folder: withoutExt.split('/')[0] });
  }

  // 被用户从目录树移出的文件夹仍然在磁盘上，其侧边栏条目不能被当成失效项清理。
  const protectedPrefixes = (Array.isArray(extraFolders) ? extraFolders : [])
    .map((folder) => normalizeRel(folder).toLowerCase())
    .filter(Boolean)
    .map((folder) => folder + '/');

  // 站内链接指向的本地文档已不存在（删除、改名、移走、目录被移空）时，清理该条目；
  // 外链、锚点、首页、README 与已移出目录均保留，避免误伤自定义结构。
  const stale = [];
  if (localDocs.length) {
    for (const group of parsed.groups) {
      for (const entry of group.entries) {
        const link = entry.link;
        if (!link || /^(https?:|mailto:|#)/i.test(link)) continue;
        if (!link.split('/')[0] || link === '/' ) continue;
        if (protectedPrefixes.some((prefix) => link === prefix.slice(0, -1) || link.startsWith(prefix))) continue;
        if (localLinks.has(link) || /(^|\/)(index|readme)$/.test(link)) continue;
        stale.push(entry);
      }
    }
  }

  let next = source;
  let removed = 0;
  if (stale.length) {
    const ranges = stale.map((entry) => {
      const lineStart = next.lastIndexOf('\n', entry.start - 1) + 1;
      const before = next.slice(lineStart, entry.start);
      const start = /^\s*$/.test(before) ? lineStart : entry.start;
      let end = entry.end + 1;
      if (next[end] === ',') end += 1;
      while (end < next.length && (next[end] === ' ' || next[end] === '\t')) end += 1;
      if (next[end] === '\r') end += 1;
      if (next[end] === '\n') end += 1;
      return { start, end };
    }).sort((a, b) => b.start - a.start);
    for (const range of ranges) {
      if (range.end <= range.start) continue;
      next = next.slice(0, range.start) + next.slice(range.end);
      removed += 1;
    }
    if (!parseSidebar(next)) {
      log('VitePress 侧边栏清理失效条目后校验失败，已跳过写入。', 'warn');
      return null;
    }
  }

  const parsedNext = parseSidebar(next);
  const knownLinks = new Set();
  const groupByFolder = new Map();
  parsedNext.groups.forEach((group) => {
    group.links.forEach((link) => knownLinks.add(link));
    for (const link of group.links) {
      const folder = link.split('/')[0];
      const key = folder ? folder.toLowerCase() : '';
      if (key && !groupByFolder.has(key)) groupByFolder.set(key, group);
    }
  });

  const missing = new Map();
  for (const doc of localDocs) {
    if (knownLinks.has(normalizeLink(doc.link))) continue;
    if (!missing.has(doc.folder)) missing.set(doc.folder, []);
    missing.get(doc.folder).push({ name: doc.name, link: doc.link });
  }
  const added = [...missing.values()].reduce((sum, list) => sum + list.length, 0);

  if (added) {
    const inserts = [];
    const newGroupFolders = [];
    for (const [folder, items] of missing) {
      items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      const group = groupByFolder.get(folder.toLowerCase());
      if (group) {
        const lineIndent = itemIndent(next, group.itemsOpen, group.itemsClose, '      ');
        const lines = items.map((item) => `${lineIndent}{ text: ${quote(item.name)}, link: ${quote(item.link)} },`).join('\n');
        const inner = next.slice(group.itemsOpen + 1, group.itemsClose).trim();
        let position = group.itemsOpen + 1;
        let text;
        if (inner) {
          if (next[position] === '\r') position += 1;
          if (next[position] === '\n') position += 1;
          text = `${lines}\n`;
        } else {
          text = `\n${lines}\n${lineIndent.slice(0, Math.max(0, lineIndent.length - 2))}`;
        }
        inserts.push({ position, text });
      } else {
        newGroupFolders.push({ folder, items });
      }
    }

    if (newGroupFolders.length) {
      const tailIndent = parsedNext.groups.length
        ? insertionIndent(next, parsedNext.groups[parsedNext.groups.length - 1].start, '  ')
        : '  ';
      const indent = `${tailIndent}  `;
      const block = newGroupFolders.map(({ folder, items }) => {
        const lines = items.map((item) => `${indent}  { text: ${quote(item.name)}, link: ${quote(item.link)} },`).join('\n');
        return [
          `${tailIndent}{`,
          `${indent}text: ${quote(folder)},`,
          `${indent}collapsed: true,`,
          `${indent}items: [`,
          lines,
          `${indent}],`,
          `${tailIndent}},`
        ].join('\n');
      }).join('\n');
      inserts.push({ position: parsedNext.arrayEnd, text: `\n${block}` });
    }

    inserts.sort((a, b) => b.position - a.position);
    for (const insert of inserts) {
      next = next.slice(0, insert.position) + insert.text + next.slice(insert.position);
    }
  }

  // 没有增删也算同步成功：仍需返回配置文件路径，让发布扫描把本地 config 与远端比对。
  // 否则首次同步写入后，第二次预览会因「无需变更」返回 null，config 从变更列表消失，
  // 导致目录变更（如新增文档的侧边栏条目）始终无法被提交。
  if (next === source) return { file: configFile, count: 0, added: 0, removed: 0, unchanged: true };
  if (!parseSidebar(next)) {
    log('VitePress 侧边栏同步结果校验失败，已跳过写入。', 'warn');
    return null;
  }

  fs.writeFileSync(configFile, next, 'utf8');
  if (removed) log(`已清理 ${removed} 个已删除文档的 VitePress 侧边栏条目：${path.basename(configFile)}`, 'info');
  if (added) log(`已自动把 ${added} 个新增文档补入 VitePress 侧边栏：${path.basename(configFile)}`, 'info');
  return { file: configFile, count: added, added, removed };
}

// 从 VitePress 的 nav / sidebar 推断目录的显示名。
// 用于界面展示；目录已改为中文名后直接显示真实名，不影响发布路径。
function getFolderLabels(workspace) {
  const labels = {};
  const configFile = findConfigFile(workspace);
  if (configFile) {
    try {
      const source = fs.readFileSync(configFile, 'utf8');
      const navKey = /\bnav\s*:\s*\[/.exec(source);
      if (navKey) {
        const navStart = navKey.index + navKey[0].lastIndexOf('[');
        const navEnd = scanBalanced(source, navStart, '[', ']');
        if (navEnd > navStart) {
          const re = /\{[^{}]*\}/g;
          const block = source.slice(navStart + 1, navEnd);
          let match;
          while ((match = re.exec(block))) {
            const text = /\btext\s*:\s*(['"])([\s\S]*?)\1/.exec(match[0]);
            const link = /\blink\s*:\s*(['"])([\s\S]*?)\1/.exec(match[0]);
            if (!text || !link) continue;
            const folder = String(link[2]).replace(/^\/+/, '').split('/')[0];
            if (folder) labels[folder] = text[2];
          }
        }
      }
      const key = /\bsidebar\s*:\s*\[/.exec(source);
      if (key) {
        const arrayStart = key.index + key[0].lastIndexOf('[');
        const arrayEnd = scanBalanced(source, arrayStart, '[', ']');
        if (arrayEnd > arrayStart) {
          for (const group of readGroups(source, arrayStart, arrayEnd)) {
            for (const link of group.links) {
              const folder = link.split('/')[0];
              if (folder) labels[folder] = group.label;
            }
          }
        }
      }
    } catch (_) { /* 配置不可读时回退到内置映射 */ }
  }
  for (const [folder, label] of Object.entries(YUQUE_FOLDER_LABELS)) {
    if (!labels[folder]) labels[folder] = label;
  }
  return labels;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRel(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

// 文件夹改名后同步 VitePress 链接，避免站点侧边栏 / 首页出现死链。
// oldRel / newRel 都是相对工作区的路径，例如 "前端" 或 "前端/Vue"。
// 只改链接里的路径片段，不改动文档正文和显示文案。
function syncFolderRename(workspace, oldRel, newRel, logger) {
  const log = typeof logger === 'function' ? logger : () => {};
  const oldSeg = normalizeRel(oldRel);
  const newSeg = normalizeRel(newRel);
  if (!workspace || !oldSeg || !newSeg || oldSeg === newSeg) {
    return { changed: [], count: 0 };
  }

  const changed = [];
  let count = 0;

  // 1) VitePress 配置：link: "/旧目录/xxx" → "/新目录/xxx"
  const configFile = findConfigFile(workspace);
  const configTargets = [];
  if (configFile) configTargets.push(configFile);
  const indexFile = path.join(workspace, 'index.md');
  try {
    if (fs.statSync(indexFile).isFile()) configTargets.push(indexFile);
  } catch (_) { /* 无首页则跳过 */ }

  for (const file of configTargets) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (_) { continue; }
    const quoted = new RegExp('(["\'])' + '/' + escapeRegExp(oldSeg) + '(?=[/"\'])', 'g');
    const href = new RegExp('(href=["\'])' + escapeRegExp(oldSeg) + '(?=[/"\'])', 'g');
    let hits = 0;
    const next = source
      .replace(quoted, (_m, q) => { hits += 1; return q + '/' + newSeg; })
      .replace(href, (_m, q) => { hits += 1; return q + newSeg; });
    if (hits) {
      fs.writeFileSync(file, next, 'utf8');
      changed.push(path.relative(workspace, file).split(path.sep).join('/'));
      count += hits;
    }
  }

  // 2) 顶层目录改名时，同步生成脚本与主题组件里的目录映射键
  if (oldSeg.indexOf('/') < 0) {
    const auxFiles = [
      path.join(workspace, '.vitepress', 'theme', 'components', 'DocEnhance.vue'),
      path.join(workspace, '..', 'scripts', 'gen-config.mjs')
    ];
    const exact = new RegExp('(["\'])' + escapeRegExp(oldSeg) + '\\1', 'g');
    for (const file of auxFiles) {
      let source;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch (_) { continue; }
      let hits = 0;
      const next = source.replace(exact, (_m, q) => {
        hits += 1;
        return q + newSeg + q;
      });
      if (hits) {
        fs.writeFileSync(file, next, 'utf8');
        changed.push(path.relative(workspace, file).split(path.sep).join('/'));
        count += hits;
      }
    }
  }

  if (count) {
    log(`文件夹「${oldSeg}」已改名为「${newSeg}」，同步更新 ${count} 处 VitePress 链接。`);
  }
  return { changed, count };
}

module.exports = { findConfigFile, syncSidebar, getFolderLabels, syncFolderRename };
