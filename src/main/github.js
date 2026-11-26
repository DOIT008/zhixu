'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { toVitepressMarkdown } = require('./vitepress');
const history = require('./history');

const API_HOST = 'api.github.com';

function request(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const options = {
      hostname: API_HOST,
      path: apiPath,
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Markdown-Studio/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': payload ? Buffer.byteLength(payload) : 0
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (_) { data = raw; }
        }

        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          try {
            const redirect = new URL(res.headers.location);
            if (redirect.hostname === API_HOST) {
              return request(method, redirect.pathname + redirect.search, token, body).then(resolve, reject);
            }
          } catch (_) { /* fall through */ }
        }

        if (status >= 200 && status < 300) {
          resolve({ status, data, headers: res.headers });
          return;
        }

        const rawMessage = (data && data.message) || `GitHub API 返回 HTTP ${status}`;
        const err = new Error(friendlyApiMessage({ message: rawMessage, status }));
        err.status = status;
        err.data = data;
        err.rawMessage = rawMessage;
        reject(err);
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function encodeRepoPath(repoPath) {
  return String(repoPath).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function validateConfig(cfg) {
  const gh = cfg && cfg.github;
  // enabled / autoPublish 只控制保存后是否自动发布，不阻止手动预览与发布
  if (!gh) throw new Error('尚未配置 GitHub 发布参数，请先在「发布 → GitHub 发布设置」中填写。');
  if (!gh.owner || !gh.repo) throw new Error('请填写 GitHub 仓库 Owner 和 Repository Name。');
  if (!gh.token) throw new Error('请填写 GitHub Access Token。');
  if (!gh.branch) throw new Error('请填写目标分支。');
  return gh;
}

// 把 GitHub API 的英文报错翻译成中文、可操作的提示
function friendlyApiMessage(err) {
  const raw = String((err && err.message) || '未知错误');
  const status = err && err.status;
  if (/rate limit|secondary rate limit/i.test(raw)) return 'GitHub API 请求频率超限，请稍后再试。';
  if (/bad credentials/i.test(raw)) return 'Token 无效或已过期（Bad credentials），请在设置里重新填写。';
  if (/not accessible by personal access token/i.test(raw)) {
    return 'Token 没有该仓库的写入权限（Resource not accessible by personal access token）。'
      + '请到 GitHub → Settings → Developer settings → Tokens 检查：'
      + '①经典 Token（ghp_ 开头）需勾选 repo（私有仓库）或 public_repo（公开仓库）；'
      + '②细粒度 Token（github_pat_ 开头）需授权该仓库，并把 Repository permissions → Contents 设为 Read and write；'
      + '③若仓库属于组织，还需对该组织授权 SSO。改好后请在设置里更新 Token。';
  }
  if (status === 403) {
    return `GitHub 拒绝了该操作（HTTP 403）：${raw}。请确认 Token 对该仓库具备写入权限。`;
  }
  if (status === 404 || /not found/i.test(raw)) return '找不到仓库或分支（404）。请检查 Owner、仓库名和分支是否正确，且 Token 对该仓库有读取权限。';
  return raw;
}

// 发布前权限自检：验证 Token 有效性、仓库访问与写权限，返回结构化诊断
async function checkAccess({ config, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};
  const gh = (config && config.github) || {};
  // 测试连接不要求已启用自动发布，只校验连接所需的基本字段
  if (!gh.owner || !gh.repo) throw new Error('请先填写 GitHub 仓库 Owner 和 Repository Name。');
  if (!gh.token) throw new Error('请先填写 GitHub Access Token。');
  const branch = gh.branch || 'main';
  const owner = encodeURIComponent(gh.owner);
  const repo = encodeURIComponent(gh.repo);
  const checks = [];

  log(`正在检测 ${gh.owner}/${gh.repo} 的连接与权限…`);

  // 1) Token 是否有效
  let login = '';
  try {
    const me = await request('GET', '/user', gh.token);
    login = (me.data && me.data.login) || '';
    checks.push({ ok: true, label: 'Token 有效', detail: login ? `登录用户：${login}` : '' });
    log(`Token 有效，登录用户：${login || '未知'}`);
  } catch (err) {
    const detail = friendlyApiMessage(err);
    checks.push({ ok: false, label: 'Token 无效', detail });
    log(`Token 校验失败：${detail}`, 'error');
    return { ok: false, login, checks };
  }

  // 2) 仓库是否存在、Token 是否可访问，以及是否有写权限
  try {
    const repoRes = await request('GET', `/repos/${owner}/${repo}`, gh.token);
    const data = repoRes.data || {};
    const perms = data.permissions || {};
    const canPush = perms.push === true || perms.admin === true || perms.maintain === true;
    checks.push({
      ok: true,
      label: '仓库可访问',
      detail: `${gh.owner}/${gh.repo}${data.private ? '（私有）' : '（公开）'}`
    });
    checks.push({
      ok: canPush,
      label: canPush ? '具备写入权限' : '缺少写入权限',
      detail: canPush
        ? '可以向该仓库提交文件'
        : '当前 Token 对该仓库只有读取权限，无法发布。请按下方说明为 Token 授予仓库写权限。'
    });
    log(canPush ? '仓库可访问，且具备写入权限。' : '仓库可访问，但当前 Token 缺少写入权限。', canPush ? 'info' : 'error');

    // 3) 若配置了 workflow，额外确认该文件存在（Actions 读取权限）
    if (gh.workflow) {
      try {
        await request('GET', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(gh.workflow)}`, gh.token);
        checks.push({ ok: true, label: 'Workflow 可访问', detail: gh.workflow });
      } catch (err) {
        checks.push({
          ok: false,
          label: 'Workflow 不可访问',
          detail: `无法读取 ${gh.workflow}：${friendlyApiMessage(err)}。发布仍会提交代码，但无法触发 Actions。`
        });
      }
    }

    return { ok: canPush, login, checks };
  } catch (err) {
    const detail = friendlyApiMessage(err);
    checks.push({ ok: false, label: '无法访问仓库', detail });
    log(`仓库访问失败：${detail}`, 'error');
    return { ok: false, login, checks };
  }
}

async function publishFile({ config, workspace, filePath, content, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};
  const gh = validateConfig(config);
  if (!workspace) throw new Error('当前没有工作区，无法计算仓库内路径。');

  const branch = gh.branch || 'main';
  const relative = path.relative(workspace, filePath).split(path.sep).join('/');
  const prefix = String(gh.pathPrefix || '').replace(/^\/+|\/+$/g, '').trim();
  const repoPath = [prefix, relative].filter(Boolean).join('/');
  const encodedPath = encodeRepoPath(repoPath);
  const contentsApi = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${encodedPath}`;

  log(`开始发布：${repoPath} → ${gh.owner}/${gh.repo}@${branch}`);

  let sha = null;
  try {
    const existing = await request('GET', `${contentsApi}?ref=${encodeURIComponent(branch)}`, gh.token);
    sha = existing.data && existing.data.sha ? existing.data.sha : null;
    log(`仓库中已存在该文件，SHA=${String(sha).slice(0, 8)}，将执行更新。`);
  } catch (err) {
    if (err.status === 404) {
      log('仓库中不存在该文件，将执行新建。');
    } else {
      throw new Error(`检查远程文件失败（HTTP ${err.status || '未知'}）：${err.message}`);
    }
  }

  const message = String(gh.commitTemplate || 'docs: update {file}')
    .replace(/\{file\}/g, path.basename(relative))
    .replace(/\{path\}/g, repoPath);

  // 自研扩展语法在 VitePress 中会原样显示，发布前转换为内联 HTML
  const converted = convertForPublish(content, gh, repoPath);
  if (converted.changed) log('已将编辑器扩展语法转换为 VitePress 兼容 HTML。');

  const commitBody = {
    message,
    content: Buffer.from(converted.content, 'utf8').toString('base64'),
    branch
  };
  if (sha) commitBody.sha = sha;

  log(`提交更改：${message}`);
  const putResult = await request('PUT', contentsApi, gh.token, commitBody);
  const commitUrl = (putResult.data && putResult.data.content && putResult.data.content.html_url) || '';

  let dispatch = null;
  if (gh.workflow) {
    const workflowApi = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/actions/workflows/${encodeURIComponent(gh.workflow)}/dispatches`;
    const ref = gh.workflowRef || branch;
    log(`触发 GitHub Actions：workflow=${gh.workflow}, ref=${ref}`);
    try {
      dispatch = await request('POST', workflowApi, gh.token, { ref });
      log(`Actions 已触发（HTTP ${dispatch.status}）。`);
    } catch (err) {
      throw new Error(`代码已提交，但触发 Actions 失败（HTTP ${err.status || '未知'}）：${err.message}`);
    }
  } else {
    log('未配置 Workflow 文件，跳过 Actions 触发。');
  }

  log('发布流程完成。');
  return {
    repoPath,
    commitUrl,
    commitStatus: putResult.status,
    dispatchStatus: dispatch ? dispatch.status : null
  };
}

// ============================================================
// 发布前变更扫描 + 选择性批量发布
// ============================================================

const crypto = require('crypto');

// 计算 Git blob 对象的 SHA-1：sha1("blob " + byteLength + "\0" + content)
// Git 与 GitHub Contents API 返回的 sha 均基于此值，可用于精确比对本地/远程内容
function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  const header = Buffer.from(`blob ${buf.length}\0`, 'binary');
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

function normalizePrefix(prefix) {
  return String(prefix || '').replace(/^\/+|\/+$/g, '').trim();
}

// 与 publishFile 保持一致：工作区文件 → 仓库内路径
function repoPathFor(workspace, filePath, gh) {
  const relative = path.relative(workspace, filePath).split(path.sep).join('/');
  const prefix = normalizePrefix(gh.pathPrefix);
  return { relative, repoPath: [prefix, relative].filter(Boolean).join('/') };
}

function isMarkdownPath(p) {
  return /\.(md|markdown|mdx)$/i.test(p);
}

function isAssetPath(p) {
  return /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i.test(p);
}

function imageBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

// 一次性拉取整棵远程文件树（path → sha），比逐文件 GET 高效得多
async function fetchRemoteTree(gh, branch) {
  const api = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  let data;
  try {
    const res = await request('GET', api, gh.token);
    data = res.data;
  } catch (err) {
    // 空仓库 / 分支尚无 tree 时返回 404，视为空
    if (err.status === 404) return { files: new Map(), truncated: false, empty: true };
    throw new Error(`读取远程文件树失败（HTTP ${err.status || '未知'}）：${err.message}`);
  }
  const files = new Map();
  const tree = (data && data.tree) || [];
  for (const item of tree) {
    if (item.type === 'blob' && typeof item.path === 'string') files.set(item.path, item.sha);
  }
  return { files, truncated: !!(data && data.truncated), empty: false };
}

// 发布前按"将要发布的内容"计算本地 SHA（含语法转换），与远程 blob sha 对齐
function convertForPublish(content, gh, repoPath) {
  // 语法转换只针对 Markdown；配置文件等非文档内容必须原样提交
  if (gh.convertSyntax === false || !isMarkdownPath(String(repoPath || ''))) {
    return { content: String(content ?? ''), changed: false };
  }
  return toVitepressMarkdown(content);
}

async function scanChanges({ config, workspace, files, assetFiles, extraFiles, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};
  const gh = validateConfig(config);
  if (!workspace) throw new Error('当前没有工作区，无法扫描发布变更。');

  const branch = gh.branch || 'main';
  const prefix = normalizePrefix(gh.pathPrefix);
  log(`正在扫描发布变更：${gh.owner}/${gh.repo}@${branch}${prefix ? '（目录 ' + prefix + '）' : ''}`);

  const remote = await fetchRemoteTree(gh, branch);
  if (remote.truncated) log('警告：远程仓库文件树过大，结果可能不完整。', 'warn');

  // 仅统计发布目录范围内的 Markdown 文件
  const remoteMd = new Map();
  for (const [p, sha] of remote.files) {
    if (!isMarkdownPath(p)) continue;
    if (prefix && !(p === prefix || p.startsWith(prefix + '/'))) continue;
    remoteMd.set(p, sha);
  }

  const localMd = new Map();
  const inputFiles = Array.isArray(files) ? files : [];
  for (const file of inputFiles) {
    let content;
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch (err) {
      log(`跳过无法读取的文件：${file.relative}（${err.message}）`, 'warn');
      continue;
    }
    const { relative, repoPath } = repoPathFor(workspace, file.path, gh);
    const converted = convertForPublish(content, gh, repoPath);
    localMd.set(repoPath, {
      repoPath,
      relative,
      name: path.basename(relative),
      filePath: file.path,
      status: 'unchanged',
      localSha: gitBlobSha(converted.content),
      remoteSha: null,
      size: Buffer.byteLength(converted.content, 'utf8')
    });
  }

  // 附带文件（如 VitePress 侧边栏配置）：与远程整棵树比对，且不做语法转换
  const localExtra = [];
  for (const file of (Array.isArray(extraFiles) ? extraFiles : [])) {
    if (!file || !file.path) continue;
    let content;
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch (err) {
      log(`跳过无法读取的附带文件：${file.path}（${err.message}）`, 'warn');
      continue;
    }
    const { relative, repoPath } = repoPathFor(workspace, file.path, gh);
    const localSha = gitBlobSha(content);
    const remoteSha = remote.files.get(repoPath) || null;
    if (remoteSha && remoteSha === localSha) continue;
    localExtra.push({
      repoPath,
      relative,
      name: path.basename(relative),
      filePath: file.path,
      status: remoteSha ? 'modified' : 'added',
      localSha,
      remoteSha,
      size: Buffer.byteLength(content, 'utf8')
    });
  }

  // 图片等二进制资源：按真实字节计算 blob SHA，不做任何文本转换
  const localAssets = [];
  for (const file of (Array.isArray(assetFiles) ? assetFiles : [])) {
    if (!file || !file.path) continue;
    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (err) {
      log(`跳过无法读取的图片：${file.relative}（${err.message}）`, 'warn');
      continue;
    }
    const { relative, repoPath } = repoPathFor(workspace, file.path, gh);
    const localSha = gitBlobSha(buffer);
    const remoteSha = remote.files.get(repoPath) || null;
    if (remoteSha && remoteSha === localSha) continue;
    localAssets.push({
      repoPath,
      relative,
      name: path.basename(relative),
      filePath: file.path,
      status: remoteSha ? 'modified' : 'added',
      localSha,
      remoteSha,
      size: buffer.length,
      asset: true
    });
  }

  const changes = [];
  // 本地存在：新增 或 内容有改动
  for (const item of localMd.values()) {
    const sha = remoteMd.get(item.repoPath);
    if (!sha) {
      item.status = 'added';
    } else if (sha !== item.localSha) {
      item.status = 'modified';
      item.remoteSha = sha;
    } else {
      continue; // 完全相同，不进入变更列表
    }
    changes.push(item);
  }
  changes.push(...localExtra);
  changes.push(...localAssets);
  // 远程存在、本地缺失：待删除
  for (const [repoPath, sha] of remoteMd) {
    if (localMd.has(repoPath)) continue;
    changes.push({
      repoPath,
      relative: prefix && repoPath.startsWith(prefix + '/') ? repoPath.slice(prefix.length + 1) : repoPath,
      name: path.basename(repoPath),
      filePath: null,
      status: 'deleted',
      localSha: null,
      remoteSha: sha,
      size: 0
    });
  }

  const order = { modified: 0, added: 1, deleted: 2 };
  changes.sort((a, b) => (order[a.status] - order[b.status]) || a.repoPath.localeCompare(b.repoPath, 'zh-CN'));

  log(`扫描完成：共 ${changes.length} 个文件待发布（修改 ${changes.filter(c => c.status === 'modified').length} / 新增 ${changes.filter(c => c.status === 'added').length} / 删除 ${changes.filter(c => c.status === 'deleted').length}）。`);
  return {
    branch,
    owner: gh.owner,
    repo: gh.repo,
    prefix,
    changes,
    totalLocal: localMd.size + localExtra.length + localAssets.length,
    totalRemote: remoteMd.size,
    truncated: remote.truncated
  };
}

// 行级 LCS diff，仅保留变更附近上下文，避免前端渲染海量内容
function buildLineDiff(oldText, newText, context = 3) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const MAX = 1200;
  if (a.length > MAX || b.length > MAX) {
    return {
      lines: [
        { type: 'del', text: `（远程共 ${a.length} 行，内容过大，省略逐行对比）`, oldLine: 1, newLine: 0 },
        { type: 'add', text: `（本地共 ${b.length} 行，请在编辑器中查看）`, oldLine: 0, newLine: 1 }
      ],
      additions: b.length,
      deletions: a.length,
      truncated: true
    };
  }

  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i, j) => dp[i * (m + 1) + j];
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const all = [];
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ type: 'ctx', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i += 1; j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      all.push({ type: 'del', text: a[i], oldLine: i + 1, newLine: 0 });
      deletions += 1; i += 1;
    } else {
      all.push({ type: 'add', text: b[j], oldLine: 0, newLine: j + 1 });
      additions += 1; j += 1;
    }
  }
  while (i < n) { all.push({ type: 'del', text: a[i], oldLine: i + 1, newLine: 0 }); deletions += 1; i += 1; }
  while (j < m) { all.push({ type: 'add', text: b[j], oldLine: 0, newLine: j + 1 }); additions += 1; j += 1; }

  // 折叠未变更区域，只保留变更行前后 context 行
  const keep = new Set();
  all.forEach((row, idx) => {
    if (row.type === 'ctx') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(all.length - 1, idx + context); k += 1) keep.add(k);
  });
  const lines = [];
  let lastIdx = -2;
  all.forEach((row, idx) => {
    if (!keep.has(idx)) return;
    if (idx > lastIdx + 1) lines.push({ type: 'gap', text: '⋯ 省略未变更内容 ⋯', oldLine: 0, newLine: 0 });
    lines.push(row);
    lastIdx = idx;
  });

  return { lines, additions, deletions, truncated: false, totalLines: all.length };
}

async function readRemoteBlobBuffer(gh, sha) {
  const api = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/git/blobs/${encodeURIComponent(sha)}`;
  const res = await request('GET', api, gh.token);
  const data = res.data || {};
  const encoding = data.encoding || 'base64';
  const raw = String(data.content || '').replace(/\s/g, '');
  return encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(String(data.content || ''), 'utf8');
}

async function readRemoteBlob(gh, sha) {
  return (await readRemoteBlobBuffer(gh, sha)).toString('utf8');
}

async function getFileDiff({ config, workspace, change, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};
  const gh = validateConfig(config);
  if (!change || !change.repoPath) throw new Error('缺少要对比的文件。');
  if (change.asset || isAssetPath(change.repoPath)) {
    return buildLineDiff('', `二进制资源：${change.repoPath}\n本地大小：${change.size || 0} 字节\n状态：${change.status}`);
  }

  if (change.status === 'added') {
    let content = '';
    try { content = fs.readFileSync(change.filePath, 'utf8'); } catch (err) { throw new Error(`读取本地文件失败：${err.message}`); }
    const converted = convertForPublish(content, gh, change.repoPath);
    return buildLineDiff('', converted.content);
  }
  if (change.status === 'deleted') {
    if (!change.remoteSha) throw new Error('缺少远程文件 SHA，无法生成对比。');
    const remoteText = await readRemoteBlob(gh, change.remoteSha);
    return buildLineDiff(remoteText, '');
  }

  if (!change.filePath) throw new Error('缺少本地文件路径，无法生成对比。');
  let localContent;
  try { localContent = fs.readFileSync(change.filePath, 'utf8'); } catch (err) { throw new Error(`读取本地文件失败：${err.message}`); }
  const converted = convertForPublish(localContent, gh, change.repoPath);
  const remoteText = change.remoteSha ? await readRemoteBlob(gh, change.remoteSha) : '';
  log(`已生成对比：${change.repoPath}`);
  return buildLineDiff(remoteText, converted.content);
}

// 用 Git Data API 在一次 commit 内提交多个文件（增删统一），workflow 只触发一次
async function publishBatch({ config, workspace, selections, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};
  const gh = validateConfig(config);
  if (!workspace) throw new Error('当前没有工作区，无法发布。');
  const list = Array.isArray(selections) ? selections : [];
  if (!list.length) throw new Error('没有选中要发布的文件。');

  const branch = gh.branch || 'main';
  const prefix = normalizePrefix(gh.pathPrefix);
  const owner = encodeURIComponent(gh.owner);
  const repo = encodeURIComponent(gh.repo);

  log(`准备批量发布 ${list.length} 个文件到 ${gh.owner}/${gh.repo}@${branch}`);

  // 1. 当前分支 HEAD commit 与 tree
  let baseCommit = null;
  let baseTree = null;
  try {
    const ref = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, gh.token);
    baseCommit = ref.data && ref.data.object && ref.data.object.sha;
    if (baseCommit) {
      const commit = await request('GET', `/repos/${owner}/${repo}/git/commits/${baseCommit}`, gh.token);
      baseTree = commit.data && commit.data.tree && commit.data.tree.sha;
    }
  } catch (err) {
    if (err.status !== 404) throw new Error(`读取远程分支失败（HTTP ${err.status || '未知'}）：${err.message}`);
    log('远程分支为空，将创建首个提交。');
  }

  // 2. 逐个创建 blob（删除项用 sha:null 表示）
  const treeEntries = [];
  for (const item of list) {
    const repoPath = normalizePrefix(item.repoPath || [prefix, item.relative].filter(Boolean).join('/'));
    if (!repoPath) continue;
    if (item.status === 'deleted') {
      treeEntries.push({ path: repoPath, mode: '100644', type: 'blob', sha: null });
      log(`标记删除：${repoPath}`);
      continue;
    }
    if (!item.filePath) throw new Error(`缺少本地文件路径：${repoPath}`);
    const binary = !!item.asset || isAssetPath(repoPath);
    let encoded;
    let syntaxChanged = false;
    if (binary) {
      let buffer;
      try { buffer = fs.readFileSync(item.filePath); } catch (err) { throw new Error(`读取 ${repoPath} 失败：${err.message}`); }
      encoded = buffer.toString('base64');
    } else {
      let content;
      try { content = fs.readFileSync(item.filePath, 'utf8'); } catch (err) { throw new Error(`读取 ${repoPath} 失败：${err.message}`); }
      const converted = convertForPublish(content, gh, repoPath);
      syntaxChanged = !!converted.changed;
      encoded = Buffer.from(converted.content, 'utf8').toString('base64');
    }
    const blob = await request('POST', `/repos/${owner}/${repo}/git/blobs`, gh.token, {
      content: encoded,
      encoding: 'base64'
    });
    treeEntries.push({ path: repoPath, mode: '100644', type: 'blob', sha: blob.data.sha });
    log(`已准备：${repoPath}${syntaxChanged ? '（已转换扩展语法）' : ''}`);
  }

  if (!treeEntries.length) throw new Error('没有可提交的文件。');

  // 3. 创建 tree（基于原 tree，只改动选中项）
  const treePayload = { tree: treeEntries };
  if (baseTree) treePayload.base_tree = baseTree;
  const treeRes = await request('POST', `/repos/${owner}/${repo}/git/trees`, gh.token, treePayload);
  const newTree = treeRes.data && treeRes.data.sha;

  // 4. 创建 commit
  const message = String(gh.commitTemplate || 'docs: update {file}')
    .replace(/\{file\}/g, list.length === 1 ? path.basename(list[0].repoPath || list[0].relative || '') : `${list.length} 个文件`)
    .replace(/\{path\}/g, prefix || '/')
    .replace(/\{count\}/g, String(list.length));
  const commitPayload = { message, tree: newTree };
  if (baseCommit) commitPayload.parents = [baseCommit];
  const commitRes = await request('POST', `/repos/${owner}/${repo}/git/commits`, gh.token, commitPayload);
  const newCommit = commitRes.data && commitRes.data.sha;
  log(`已创建提交：${message}`);

  // 5. 更新分支引用
  if (baseCommit) {
    await request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, gh.token, { sha: newCommit, force: false });
  } else {
    await request('POST', `/repos/${owner}/${repo}/git/refs`, gh.token, { ref: `refs/heads/${branch}`, sha: newCommit });
  }

  // 6. 触发 workflow（一次）
  let dispatch = null;
  if (gh.workflow) {
    const workflowApi = `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(gh.workflow)}/dispatches`;
    const ref = gh.workflowRef || branch;
    log(`触发 GitHub Actions：workflow=${gh.workflow}, ref=${ref}`);
    try {
      dispatch = await request('POST', workflowApi, gh.token, { ref });
      log(`Actions 已触发（HTTP ${dispatch.status}）。`);
    } catch (err) {
      throw new Error(`代码已提交，但触发 Actions 失败（HTTP ${err.status || '未知'}）：${err.message}`);
    }
  } else {
    log('未配置 Workflow 文件，跳过 Actions 触发。');
  }

  log(`批量发布完成：${list.length} 个文件，提交 ${String(newCommit).slice(0, 8)}。`);
  return {
    commitSha: newCommit,
    commitUrl: `https://github.com/${gh.owner}/${gh.repo}/commit/${newCommit}`,
    count: list.length,
    dispatchStatus: dispatch ? dispatch.status : null
  };
}

// 撤销单个变更：把本地文件恢复成线上版本。
// modified → 用线上内容覆盖本地；deleted → 从线上重建本地文件；added → 删除本地新增文件（移入回收站）。
// 覆盖/删除前一律先存一份本地快照，便于反悔。
async function revertChange({ config, workspace, change, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};
  const gh = validateConfig(config);
  if (!workspace) throw new Error('当前没有工作区，无法撤销。');
  if (!change || !change.repoPath) throw new Error('缺少要撤销的文件信息。');
  const status = change.status;

  const isAsset = !!change.asset || isAssetPath(change.repoPath);
  if (status === 'added') {
    // 线上不存在此文件 → 撤销即删除本地新增文件
    if (!change.filePath) throw new Error('缺少本地文件路径，无法删除新增文件。');
    if (!isAsset) {
      let localContent = '';
      try { localContent = fs.readFileSync(change.filePath, 'utf8'); } catch (_) { /* 文件可能已被删 */ }
      if (localContent) {
        try { history.saveSnapshot(change.filePath, localContent, '撤销新增前'); } catch (_) {}
      }
    }
    await shell.trashItem(change.filePath);
    log(`已撤销新增并移入回收站：${change.repoPath}`);
    return { status: 'added', filePath: change.filePath };
  }

  // modified / deleted 都需要线上原文
  if (!change.remoteSha) throw new Error('缺少线上文件 SHA，无法恢复线上版本。');
  const remoteBuffer = await readRemoteBlobBuffer(gh, change.remoteSha);
  const remoteText = isAsset ? '' : remoteBuffer.toString('utf8');
  const target = status === 'deleted'
    ? path.join(workspace, change.relative)      // 本地被删：按相对路径重建
    : change.filePath;                            // 本地被改：覆盖原文件
  if (!target) throw new Error('缺少本地文件路径，无法恢复。');

  // 覆盖前保存当前本地内容为快照（被删文件本地已无内容，图片不做文本快照）
  if (status === 'modified' && !isAsset) {
    try {
      const localContent = fs.readFileSync(target, 'utf8');
      history.saveSnapshot(target, localContent, '撤销修改前');
    } catch (_) { /* 读不到就跳过快照 */ }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, isAsset ? remoteBuffer : remoteText);
  log(`已恢复为线上版本：${change.repoPath}`);
  return { status, filePath: target, content: isAsset ? undefined : remoteText };
}

module.exports = {
  publishFile, validateConfig, scanChanges, getFileDiff, publishBatch,
  gitBlobSha, buildLineDiff, revertChange, checkAccess, friendlyApiMessage, convertForPublish
};
