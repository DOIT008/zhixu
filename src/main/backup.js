'use strict';

// 草稿备份：只保存「有路径的文档」的未提交内容，写入 userData/drafts。
// 与 history 快照不同，草稿是崩溃恢复用的，保存更频繁但只保留最近少量文件。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MAX_DRAFTS = 24;
const MAX_AGE_DAYS = 7;

function draftDir() {
  return path.join(app.getPath('userData'), 'drafts');
}

function draftId(filePath) {
  return crypto.createHash('sha1').update(String(filePath || '').replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
}

function ensureDir() {
  fs.mkdirSync(draftDir(), { recursive: true });
}

function saveDraft(payload) {
  const filePath = payload && payload.filePath ? path.resolve(String(payload.filePath)) : '';
  if (!filePath) return null;
  const content = typeof payload.content === 'string' ? payload.content : '';
  ensureDir();
  const item = {
    id: draftId(filePath),
    filePath,
    content,
    savedAt: Date.now()
  };
  const file = path.join(draftDir(), `${item.id}.json`);
  fs.writeFileSync(file, JSON.stringify(item), 'utf8');
  prune();
  return { id: item.id, filePath: item.filePath, savedAt: item.savedAt, size: content.length };
}

function listDrafts() {
  ensureDir();
  const now = Date.now();
  const items = [];
  for (const name of fs.readdirSync(draftDir())) {
    if (!/^[a-f0-9]{16}\.json$/i.test(name)) continue;
    try {
      const item = JSON.parse(fs.readFileSync(path.join(draftDir(), name), 'utf8'));
      if (!item || !item.filePath || typeof item.content !== 'string') continue;
      if (now - Number(item.savedAt || 0) > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(path.join(draftDir(), name));
        continue;
      }
      items.push(item);
    } catch (_err) {
      // 损坏的草稿直接忽略，不影响主流程
    }
  }
  return items.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0)).slice(0, MAX_DRAFTS);
}

function readDraft(id) {
  if (!/^[a-f0-9]{16}$/i.test(String(id || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(draftDir(), `${id}.json`), 'utf8'));
  } catch (_err) {
    return null;
  }
}

function deleteDraft(id) {
  if (!/^[a-f0-9]{16}$/i.test(String(id || ''))) return false;
  try {
    fs.unlinkSync(path.join(draftDir(), `${id}.json`));
    return true;
  } catch (_err) {
    return false;
  }
}

function deleteDraftByPath(filePath) {
  if (!filePath) return false;
  return deleteDraft(draftId(filePath));
}

function prune() {
  const items = listDrafts();
  for (const item of items.slice(MAX_DRAFTS)) deleteDraft(item.id);
}

module.exports = { saveDraft, listDrafts, readDraft, deleteDraft, deleteDraftByPath, draftDir };
