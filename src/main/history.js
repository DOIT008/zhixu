'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const SNAPSHOTS_DIR = path.join(app.getPath('userData'), 'snapshots');
const MANIFEST = 'index.json';
const DEFAULT_LIMIT = 40;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function filePathToKey(filePath) {
  return crypto.createHash('sha1').update(String(filePath || '')).digest('hex').slice(0, 16);
}

function manifestPath() {
  return path.join(SNAPSHOTS_DIR, MANIFEST);
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch (_err) {
    return {};
  }
}

function writeManifest(manifest) {
  ensureDir(SNAPSHOTS_DIR);
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
}

function stampToName(filePath, stamp, unique) {
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // 同秒内多次保存需要唯一后缀，否则文件名冲突会互相覆盖
  return `${filePathToKey(filePath)}-${time}-${unique}.md`;
}

// 保存一次快照：内容写入独立 .md 文件，索引记录元数据
function saveSnapshot(filePath, content, label) {
  const key = filePathToKey(filePath);
  const stamp = Date.now();
  const unique = `${stamp.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = stampToName(filePath, stamp, unique);
  ensureDir(SNAPSHOTS_DIR);
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, name), String(content ?? ''), 'utf8');

  const manifest = readManifest();
  if (!Array.isArray(manifest[key])) manifest[key] = [];
  manifest[key].unshift({
    id: `${key}-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
    file: name,
    filePath: String(filePath || ''),
    name: path.basename(String(filePath || '未命名文档.md')),
    stamp,
    label: label || '',
    size: Buffer.byteLength(String(content ?? ''), 'utf8')
  });
  writeManifest(manifest);
  return manifest[key][0];
}

// 列出某文件的版本历史
function listSnapshots(filePath, limit) {
  const key = filePathToKey(filePath);
  const manifest = readManifest();
  const items = Array.isArray(manifest[key]) ? manifest[key] : [];
  const max = Math.min(Number(limit) || DEFAULT_LIMIT, 200);
  return items.slice(0, max).map((item) => ({ ...item }));
}

// 读取某个快照内容（不自动恢复，交给渲染层决定）
function readSnapshot(snapshotId) {
  const manifest = readManifest();
  for (const key of Object.keys(manifest)) {
    const list = Array.isArray(manifest[key]) ? manifest[key] : [];
    const found = list.find((item) => item.id === snapshotId);
    if (found) {
      const file = path.join(SNAPSHOTS_DIR, found.file);
      if (!file.startsWith(SNAPSHOTS_DIR)) throw new Error('快照路径无效。');
      return { id: found.id, filePath: found.filePath, stamp: found.stamp, content: fs.readFileSync(file, 'utf8') };
    }
  }
  throw new Error('未找到该版本快照。');
}

// 清理超出上限的旧快照
function prune(filePath, limit) {
  const key = filePathToKey(filePath);
  const manifest = readManifest();
  const items = Array.isArray(manifest[key]) ? manifest[key] : [];
  const max = Math.min(Number(limit) || DEFAULT_LIMIT, 200);
  if (items.length <= max) return 0;
  const removed = items.splice(max);
  removed.forEach((item) => {
    try { fs.unlinkSync(path.join(SNAPSHOTS_DIR, item.file)); } catch (_err) { /* ignore */ }
  });
  manifest[key] = items;
  writeManifest(manifest);
  return removed.length;
}

module.exports = { saveSnapshot, listSnapshots, readSnapshot, prune, SNAPSHOTS_DIR };
