'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// 配置读取在启动与保存时会被多次调用。按 mtime 做轻量缓存，避免反复读取文件、
// 反复解密所有工作区的 Token；所有写入口仍通过 save()，会主动失效缓存。
let cachedConfig = null;
let cachedMtimeMs = -1;

const DEFAULTS = {
  lastWorkspace: '',
  recentFiles: [],
  // 最近打开的工作区（文件夹），与文件列表分开保存
  recentWorkspaces: [],
  // 会话恢复：记住上次打开的文档标签与当前激活的文件
  session: { files: [], activePath: '' },
  // 按工作区记录的「从目录树移出」文件夹（相对路径）
  excludedDirs: {},
  // 按工作区隔离的 GitHub 发布配置：key 为工作区绝对路径，value 为 github 配置对象
  githubByWorkspace: {},
  // 更新检查：填写 owner/repo 后可在「帮助 → 检查更新」中手动对比 Releases
  update: { repo: '', enabled: true },
  editor: {
    fontSize: 16,
    viewMode: 'split',
    showLog: false,
    theme: 'light',
    previewOutline: true,
    autoSave: false,
    autoSaveDelay: 30,
    snapshotLimit: 40
  },
  github: {
    // 旧字段，仅用于兼容老配置；手动发布不再依赖它
    enabled: false,
    // 仅控制“保存后自动发布”，不勾选时仍可手动预览并发布
    autoPublish: false,
    owner: '',
    repo: '',
    branch: 'main',
    token: '',
    tokenEncrypted: false,
    pathPrefix: 'docs',
    convertSyntax: true,
    commitTemplate: 'docs: update {file}',
    workflow: 'deploy.yml',
    workflowRef: ''
  }
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, extra) {
  const out = clone(base);
  if (!extra || typeof extra !== 'object') return out;
  for (const key of Object.keys(extra)) {
    const val = extra[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && out[key] && typeof out[key] === 'object') {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// 对一个 github 配置对象解密 token（原地修改）
function decryptGhToken(gh) {
  if (!gh || !gh.tokenEncrypted || !gh.token) return gh;
  if (safeStorage.isEncryptionAvailable()) {
    try {
      gh.token = safeStorage.decryptString(Buffer.from(gh.token, 'base64'));
    } catch (err) {
      console.warn('[config] Token 解密失败，已清空：', err.message);
      gh.token = '';
    }
  } else {
    console.warn('[config] 系统不支持 safeStorage，无法解密已保存的 Token，已清空。');
    gh.token = '';
  }
  gh.tokenEncrypted = false;
  return gh;
}

// 对一个 github 配置对象加密 token（原地修改）
function encryptGhToken(gh) {
  if (!gh) return gh;
  const token = String(gh.token || '');
  if (token) {
    if (safeStorage.isEncryptionAvailable()) {
      gh.token = safeStorage.encryptString(token).toString('base64');
      gh.tokenEncrypted = true;
    } else {
      gh.token = token;
      gh.tokenEncrypted = false;
      console.warn('[config] 当前系统不支持 safeStorage，Token 将以明文保存。请勿共享 config.json。');
    }
  } else {
    gh.token = '';
    gh.tokenEncrypted = false;
  }
  return gh;
}

function load() {
  const file = configPath();
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (_err) {
    stat = null;
  }
  if (cachedConfig && stat && stat.mtimeMs === cachedMtimeMs) return clone(cachedConfig);

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[config] 读取配置失败，使用默认配置：', err.message);
    }
    raw = {};
  }

  const cfg = deepMerge(DEFAULTS, raw);
  // 解密顶层默认配置（兼容旧版单仓库用法）
  decryptGhToken(cfg.github);
  // 解密各工作区的配置
  if (cfg.githubByWorkspace && typeof cfg.githubByWorkspace === 'object') {
    for (const key of Object.keys(cfg.githubByWorkspace)) {
      decryptGhToken(cfg.githubByWorkspace[key]);
    }
  }
  cachedConfig = cfg;
  cachedMtimeMs = stat ? stat.mtimeMs : -1;
  return clone(cfg);
}

// 普通配置写入（会话/偏好/最近打开等）绝不能覆盖 GitHub 配置：
// 渲染层的 state.config.github 可能来自“当前工作区”的空配置，直接写回会清空旧版顶层配置。
// 只有保存 GitHub 设置或旧配置迁移时才显式传入 includeGithub。
function save(cfg, options) {
  const current = load();
  const out = deepMerge(DEFAULTS, cfg);
  if (!options || !options.includeGithub) {
    out.github = current.github;
    out.githubByWorkspace = current.githubByWorkspace;
  }
  // 加密顶层默认配置与各工作区配置的 token（分开处理，避免共享引用）
  encryptGhToken(out.github);
  if (out.githubByWorkspace && typeof out.githubByWorkspace === 'object') {
    for (const key of Object.keys(out.githubByWorkspace)) {
      out.githubByWorkspace[key] = encryptGhToken(clone(out.githubByWorkspace[key]));
    }
  }

  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 保留上一份配置，避免误操作后无法恢复
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch (_) { /* 备份失败不阻断保存 */ }
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  cachedConfig = null;
  cachedMtimeMs = -1;
  return load();
}

// 工作区 key 规范化：统一斜杠与大小写，避免同一路径因写法差异产生多份配置
function workspaceKey(workspacePath) {
  return String(workspacePath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// 从本地 .git/config 的 remote 推断 GitHub 仓库（优先 origin，其次任意 github.com remote）
function parseGithubRemoteUrl(remoteUrl) {
  const cleaned = String(remoteUrl || '').trim().replace(/\.git$/i, '');
  const match = cleaned.match(/^(?:https?:\/\/|git:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  try {
    return {
      owner: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2])
    };
  } catch (_) {
    return { owner: match[1], repo: match[2] };
  }
}

function readGitConfigPath(dir) {
  try {
    const gitEntry = path.join(dir, '.git');
    const stat = fs.statSync(gitEntry);
    if (stat.isDirectory()) return path.join(gitEntry, 'config');
    if (stat.isFile()) {
      // git worktree / submodule：.git 是指向真实 git 目录的指针文件
      const pointer = fs.readFileSync(gitEntry, 'utf8').match(/^\s*gitdir:\s*(.+?)\s*$/im);
      if (pointer) return path.join(path.resolve(dir, pointer[1].trim()), 'config');
    }
  } catch (_) { /* 继续向上查找 */ }
  return null;
}

function detectGithubRepo(workspacePath) {
  if (!workspacePath) return null;
  // 工作区常是仓库的子目录（例如 repo/docs），向上逐层查找 .git
  let dir = path.resolve(workspacePath);
  let gitConfigPath = null;
  for (let level = 0; level < 12 && dir; level += 1) {
    gitConfigPath = readGitConfigPath(dir);
    if (gitConfigPath) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!gitConfigPath) return null;

  let text = '';
  try {
    text = fs.readFileSync(gitConfigPath, 'utf8');
  } catch (_) {
    return null;
  }

  const remotes = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/i);
    if (section) {
      current = { name: section[1], url: '' };
      remotes.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (current && !current.url) {
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/i);
      if (url) current.url = url[1].trim();
    }
  }
  const ordered = [
    ...remotes.filter((item) => item.name === 'origin'),
    ...remotes.filter((item) => item.name !== 'origin')
  ];
  for (const remote of ordered) {
    const parsed = parseGithubRemoteUrl(remote.url);
    if (parsed) return parsed;
  }
  return null;
}

function hasGithubValues(gh) {
  return Boolean(gh && (gh.owner || gh.repo || gh.token));
}

// 旧版只有顶层 github 配置：通过“git remote 与配置中的 owner/repo 一致”推断它属于哪个工作区；
// 推断不到时退回 lastWorkspace，最后才用第一个最近工作区。避免二次切换到别的工作区后误归属。
function legacyGithubKey(cfg) {
  const candidates = [];
  if (cfg.lastWorkspace) candidates.push(cfg.lastWorkspace);
  if (Array.isArray(cfg.recentWorkspaces)) candidates.push(...cfg.recentWorkspaces);
  const gh = cfg.github || {};
  if (gh.owner && gh.repo) {
    const wanted = `${String(gh.owner).toLowerCase()}/${String(gh.repo).toLowerCase().replace(/\.git$/i, '')}`;
    for (const candidate of candidates) {
      const detected = detectGithubRepo(candidate);
      if (detected && `${detected.owner.toLowerCase()}/${detected.repo.toLowerCase()}` === wanted) {
        return workspaceKey(candidate);
      }
    }
  }
  return candidates.map(workspaceKey).find(Boolean) || '';
}

// 一旦出现任何按工作区配置，就不再把顶层配置当作其他工作区的回退。
function migrateLegacyGithub(cfg, key) {
  if (!key) return null;
  const byWs = cfg.githubByWorkspace && typeof cfg.githubByWorkspace === 'object' ? cfg.githubByWorkspace : {};
  if (Object.keys(byWs).length || !hasGithubValues(cfg.github)) return null;
  const targetKey = legacyGithubKey(cfg);
  if (targetKey !== key) return null;
  cfg.githubByWorkspace = { [targetKey]: deepMerge(DEFAULTS.github, cfg.github) };
  save(cfg, { includeGithub: true });
  return cfg.githubByWorkspace[targetKey];
}

// 取指定工作区的完整配置对象（结构同 load()，但 github 字段替换为该工作区的配置）。
// 这样所有 github.* 函数内部的 validateConfig(cfg).github 都能正常取到。
// 没有专属配置时：先兼容旧版顶层配置迁移，再尝试读取当前目录 .git 的 remote；
// 都不会再回退到“上次保存的工作区配置”，避免切换仓库时串用。
function getGithubForWorkspace(workspacePath) {
  const cfg = load();
  const key = workspaceKey(workspacePath);
  let gh = null;
  if (key && cfg.githubByWorkspace && cfg.githubByWorkspace[key]) {
    gh = deepMerge(DEFAULTS.github, cfg.githubByWorkspace[key]);
  }
  if (!gh) gh = migrateLegacyGithub(cfg, key);
  if (!gh) gh = deepMerge(DEFAULTS.github, detectGithubRepo(workspacePath) || {});
  return { ...cfg, github: clone(gh) };
}

// 保存指定工作区的 GitHub 配置；同时更新顶层配置为最近使用的一份（便于迁移与回退）
function saveGithubForWorkspace(workspacePath, gh) {
  const cfg = load();
  const key = workspaceKey(workspacePath);
  const clean = deepMerge(DEFAULTS.github, gh || {});
  if (key) {
    if (!cfg.githubByWorkspace || typeof cfg.githubByWorkspace !== 'object') cfg.githubByWorkspace = {};
    cfg.githubByWorkspace[key] = clean;
  }
  cfg.github = clone(clean);
  return save(cfg, { includeGithub: true });
}

function setLastWorkspace(workspacePath) {
  const cfg = load();
  cfg.lastWorkspace = workspacePath || '';
  save(cfg);
  return cfg;
}

// ---------- 从目录树移出的文件夹（按工作区隔离，存相对路径） ----------
function getExcludedDirs() {
  const cfg = load();
  const all = cfg.excludedDirs && typeof cfg.excludedDirs === 'object' ? cfg.excludedDirs : {};
  return all;
}

function setExcludedDirs(map) {
  const cfg = load();
  cfg.excludedDirs = map && typeof map === 'object' ? map : {};
  return save(cfg);
}

module.exports = {
  load, save, setLastWorkspace, getExcludedDirs, setExcludedDirs, configPath,
  getGithubForWorkspace, saveGithubForWorkspace, detectGithubRepo, parseGithubRemoteUrl
};
