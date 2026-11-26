'use strict';

// 更新检查：手动触发，读取用户配置的仓库 releases/latest。
// 不使用后台静默联网，避免启动时增加网络等待。

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

function currentVersion() {
  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.resourcesPath || '', 'app.asar', 'package.json')
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg && pkg.version) return pkg.version;
    } catch (_err) { /* 继续尝试下一个位置 */ }
  }
  return '0.0.0';
}

function compareVersion(a, b) {
  const parse = (value) => String(value || '').replace(/^v/i, '').split(/[.-]/).map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function fetchLatest(repo) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/latest`,
      headers: {
        'User-Agent': 'zhixu-update-check',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GitHub 返回 ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('无法解析 GitHub 返回内容')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
  });
}

async function check() {
  const current = currentVersion();
  const update = (config.load().update || {});
  const repo = String(update.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  if (!repo) {
    return { configured: false, current, latest: '', hasUpdate: false, url: '', notes: '' };
  }
  const release = await fetchLatest(repo);
  if (!release) {
    return { configured: true, current, latest: '', hasUpdate: false, url: `https://github.com/${repo}/releases`, notes: '该仓库还没有发布版本。' };
  }
  const latest = String(release.tag_name || '').replace(/^v/i, '');
  return {
    configured: true,
    current,
    latest: String(release.tag_name || ''),
    hasUpdate: compareVersion(latest, current) > 0,
    url: release.html_url || `https://github.com/${repo}/releases`,
    notes: String(release.body || '').slice(0, 1200),
    publishedAt: release.published_at
  };
}

module.exports = { check, currentVersion };
