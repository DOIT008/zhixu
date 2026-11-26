'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { dialog, shell, clipboard } = require('electron');
const config = require('./config');
const vitepressSidebar = require('./vitepress-sidebar');

const MD_FILE_RE = /\.(md|markdown|mdx)$/i;
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const execFileAsync = promisify(execFile);
const IGNORE_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'out', 'build-cache',
  '.cache', '.idea', '.vscode', '__pycache__', 'vendor'
]);

let currentWorkspace = null;

// 单独打开的文件（不属于任何工作区）也允许读写：登记其所在目录为“临时允许区”。
// 这样无需先打开文件夹即可打开/新建/保存单个 Markdown 文件。
const grantedDirs = new Set();

function getWorkspace() {
  return currentWorkspace;
}

function setWorkspace(workspacePath) {
  currentWorkspace = path.resolve(workspacePath);
  config.setLastWorkspace(currentWorkspace);
  return currentWorkspace;
}

// 登记一个目录为允许区（用于「新建文件」时用户自选的保存位置）
function grantDir(dirPath) {
  if (!dirPath) return null;
  const resolved = path.resolve(dirPath);
  grantedDirs.add(resolved);
  return resolved;
}

// 登记一个单独文件的路径：把它的父目录加入允许区
function grantFile(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  grantDir(path.dirname(resolved));
  return resolved;
}

// 新建文件对话框的默认位置：当前工作区，没有则用主目录
function getDefaultSaveDir() {
  return currentWorkspace || os.homedir();
}

// ---------- 从目录树移出的文件夹 ----------
// 按工作区隔离，使用相对路径存储；buildTree / 发布扫描 / 全局搜索统一忽略
function toRel(dirPath) {
  return path.relative(currentWorkspace, dirPath).split(path.sep).join('/');
}

function getExcludedSet() {
  if (!currentWorkspace) return new Set();
  const rels = config.getExcludedDirs()[currentWorkspace] || [];
  return new Set(Array.isArray(rels) ? rels : []);
}

function listExcludedDirs() {
  if (!currentWorkspace) return [];
  const rels = config.getExcludedDirs()[currentWorkspace] || [];
  return (Array.isArray(rels) ? rels : []).map((rel) => ({
    path: path.join(currentWorkspace, rel),
    relative: rel
  }));
}

function excludeDir(dirPath) {
  if (!currentWorkspace) throw new Error('请先选择工作区文件夹。');
  const resolved = assertInside(dirPath);
  if (resolved === path.resolve(currentWorkspace)) throw new Error('不能移出工作区根目录。');
  const rel = toRel(resolved);
  const all = config.getExcludedDirs();
  const list = Array.isArray(all[currentWorkspace]) ? all[currentWorkspace].slice() : [];
  if (!list.includes(rel)) list.push(rel);
  all[currentWorkspace] = list;
  config.setExcludedDirs(all);
  return { path: resolved, relative: rel };
}

function restoreExcludedDir(rel) {
  if (!currentWorkspace) throw new Error('请先选择工作区文件夹。');
  const all = config.getExcludedDirs();
  const list = Array.isArray(all[currentWorkspace]) ? all[currentWorkspace] : [];
  all[currentWorkspace] = list.filter((item) => item !== rel);
  config.setExcludedDirs(all);
  return { relative: rel };
}

function restoreAllExcludedDirs() {
  if (!currentWorkspace) return;
  const all = config.getExcludedDirs();
  all[currentWorkspace] = [];
  config.setExcludedDirs(all);
}

function isAllowed(resolved) {
  if (currentWorkspace) {
    const root = path.resolve(currentWorkspace);
    const rel = path.relative(root, resolved);
    if (!(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) return true;
  }
  for (const dir of grantedDirs) {
    const rel = path.relative(dir, resolved);
    if (!(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) return true;
  }
  return false;
}

function assertInside(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!isAllowed(resolved)) {
    throw new Error('访问被拒绝：目标路径不在工作区或已打开的单个文件目录内。');
  }
  return resolved;
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog({
    title: '选择 Markdown 工作区文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return setWorkspace(result.filePaths[0]);
}

// 从「最近打开的工作区」直接切换，路径失效时给出明确提示
function openWorkspacePath(workspacePath) {
  const resolved = path.resolve(String(workspacePath || ''));
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw new Error('该工作区已不存在，请从列表中移除。');
  }
  if (!stat.isDirectory()) throw new Error('该路径不是文件夹，无法作为工作区打开。');
  return setWorkspace(resolved);
}

// ---------- Git 拉取 ----------
function friendlyGitError(err) {
  if (err && err.code === 'ENOENT') return '未找到 git，请先安装 Git 并确保 git 在 PATH 中。';
  const raw = String((err && (err.stderr || err.stdout)) || err && err.message || '').trim();
  if (/not a git repository|does not appear to be a git repository/i.test(raw)) {
    return '当前工作区不在 Git 仓库中，无法拉取。';
  }
  if (/no such remote|could not find remote/i.test(raw)) {
    return '仓库没有可用的远端（origin），请先配置 remote。';
  }
  if (/no upstream|no tracking information/i.test(raw)) {
    return '当前分支未设置上游分支，请先执行 git branch --set-upstream-to=origin/<分支>。';
  }
  if (/Untracked working tree files would be overwritten/i.test(raw)) {
    return '本地有未跟踪文件与远端更新同名冲突，请先移开这些文件再拉取。';
  }
  if (/conflict|could not apply|autostash.*failed|Aborting Applied autostash/i.test(raw)) {
    return '拉取后产生冲突或暂存恢复失败，请在 Git 中解决后再试。';
  }
  if (/authentication failed|could not read username|permission denied|access denied/i.test(raw)) {
    return 'Git 认证失败，请检查 Git 凭据或 GitHub 发布设置里的 Token。';
  }
  return raw ? `git pull 失败：${raw.split('\n').slice(-3).join('\n')}` : 'git pull 失败，请查看日志。';
}

async function runGit(args, options) {
  const opts = options || {};
  try {
    // 关闭路径转义，方便解析中文/特殊字符文件名
    return await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: opts.cwd || currentWorkspace || process.cwd(),
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts.timeout || 120000,
      env: opts.env
    });
  } catch (err) {
    const wrapped = new Error(friendlyGitError(err));
    wrapped.stdout = err.stdout;
    wrapped.stderr = err.stderr;
    wrapped.code = err.code;
    throw wrapped;
  }
}

// 解析 git 报出的“未跟踪文件会被覆盖”路径，供自动备份使用
function parseUntrackedConflicts(err) {
  const raw = String((err && err.stderr) || (err && err.stdout) || (err && err.message) || '');
  if (!/Untracked working tree files would be overwritten/i.test(raw)) return [];
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /Untracked working tree files would be overwritten/i.test(line));
  const paths = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^Please move or remove/i.test(line.trim())) break;
    if (!/^\s+\S/.test(line)) continue;
    let rel = line.trim();
    if ((rel.startsWith('"') && rel.endsWith('"')) || (rel.startsWith("'") && rel.endsWith("'"))) {
      rel = rel.slice(1, -1);
    }
    if (rel) paths.push(rel);
  }
  return paths;
}

// 把冲突的未跟踪文件移到用户数据目录下的备份文件夹，不删除、不覆盖
function backupUntrackedPaths(root, relPaths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(path.dirname(config.configPath()), 'gitpull-backups', stamp);
  fs.mkdirSync(backupRoot, { recursive: true });
  const rootPrefix = path.resolve(root) + path.sep;
  const moved = [];
  for (const rel of relPaths) {
    const src = path.resolve(root, rel);
    if (src !== path.resolve(root) && !src.startsWith(rootPrefix)) continue;
    if (!fs.existsSync(src)) continue;
    const dest = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    moved.push({ from: rel, to: dest });
  }
  return { backupRoot, moved };
}

// 从当前分支的远端拉取最新内容；--autostash 保留本地未提交修改，避免覆盖正在编辑的文档。
// 若远端是 GitHub 且已保存 Token，用 Basic(x-access-token) 注入凭据，避免额外弹窗。
async function gitPull() {
  if (!currentWorkspace) throw new Error('请先打开工作区，再执行拉取。');
  const rootRes = await runGit(['rev-parse', '--show-toplevel'], { cwd: currentWorkspace });
  const root = String(rootRes.stdout || '').trim();
  if (!root) throw new Error('当前工作区不在 Git 仓库中，无法拉取。');

  let upstream = '';
  try {
    upstream = String((await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root })).stdout || '').trim();
  } catch (_) { /* 没有上游时仍尝试 origin */ }
  const remoteName = upstream && upstream.includes('/') ? upstream.split('/')[0] : 'origin';

  let remoteUrl = '';
  try {
    remoteUrl = String((await runGit(['remote', 'get-url', remoteName], { cwd: root })).stdout || '').trim();
  } catch (_) { /* 认证注入失败时仍按 Git 自身配置处理 */ }

  const env = { ...process.env };
  const token = (config.getGithubForWorkspace(currentWorkspace).github || {}).token;
  if (token && /github\.com/i.test(remoteUrl)) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }

  const args = upstream
    ? ['pull', '--rebase', '--autostash']
    : ['pull', remoteName, '--rebase', '--autostash'];
  let result = null;
  let backedUp = [];
  let backupDir = '';
  try {
    result = await runGit(args, { cwd: root, env });
  } catch (err) {
    const conflicts = parseUntrackedConflicts(err);
    if (!conflicts.length) throw err;
    // 未跟踪文件与远端新增文件同名：先整体备份移出，再重试一次
    const backup = backupUntrackedPaths(root, conflicts);
    if (!backup.moved.length) throw err;
    backedUp = backup.moved;
    backupDir = backup.backupRoot;
    try {
      result = await runGit(args, { cwd: root, env });
    } catch (retryErr) {
      retryErr.message += `\n冲突的未跟踪文件已备份到：${backupDir}`;
      throw retryErr;
    }
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { root, remote: remoteName, upstream, output, backedUp, backupDir };
}

// 选择新建文件的保存位置：打开目录选择框，并登记为允许区（不切换工作区）
async function chooseSaveDir(defaultPath) {
  const result = await dialog.showOpenDialog({
    title: '选择新建文件的保存位置',
    defaultPath: defaultPath || getDefaultSaveDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return grantDir(result.filePaths[0]);
}

async function chooseFile() {
  const result = await dialog.showOpenDialog({
    title: '打开 Markdown 文件',
    defaultPath: currentWorkspace || os.homedir(),
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  // 允许打开工作区外的单个文件：登记其目录后直接返回
  return grantFile(result.filePaths[0]);
}

async function saveAsDialog(defaultPath) {
  let fallback = 'untitled.md';
  if (defaultPath) fallback = path.basename(defaultPath) || fallback;
  if (currentWorkspace) fallback = path.join(currentWorkspace, fallback);
  else fallback = path.join(os.homedir(), fallback);
  const result = await dialog.showSaveDialog({
    title: '另存为 Markdown 文件',
    defaultPath: fallback,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  // 另存到任意位置后，其目录也应可继续读写
  return grantFile(result.filePath);
}

function buildTree(dirPath, depth, counter, excluded = new Set()) {
  if (depth > 12 || counter.count > 4000) return [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return [{ name: '（无法读取目录）', path: dirPath, type: 'file', error: err.message, children: [] }];
  }

  const nodes = [];
  for (const entry of entries) {
    if (counter.count > 4000) break;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const fullPath = path.join(dirPath, entry.name);
    counter.count += 1;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      // 被用户「移出目录树」的文件夹：整棵子树不再显示
      if (excluded.has(toRel(fullPath))) continue;
      const children = buildTree(fullPath, depth + 1, counter, excluded);
      // 文件夹一律展示（含新建的空文件夹），方便用户看到刚创建的目录
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'dir',
        children
      });
    } else if (entry.isFile() && (MD_FILE_RE.test(entry.name) || IMAGE_FILE_RE.test(entry.name))) {
      // 目录树展示 Markdown 文件与图片（图片可在预览区查看）
      const isImage = IMAGE_FILE_RE.test(entry.name);
      nodes.push({ name: entry.name, path: fullPath, type: isImage ? 'image' : 'file', children: [] });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return nodes;
}

function readTree() {
  if (!currentWorkspace) return [];
  const nodes = buildTree(currentWorkspace, 0, { count: 0 }, getExcludedSet());
  // VitePress 目录名是语雀导出的 ID：只在界面上显示中文分组名，磁盘路径保持不变
  const labels = vitepressSidebar.getFolderLabels(currentWorkspace);
  function applyLabels(items) {
    for (const node of items) {
      if (node.type === 'dir') {
        const label = labels[path.basename(node.path).toLowerCase()];
        if (label && label !== node.name) node.label = label;
        applyLabels(node.children || []);
      }
    }
  }
  applyLabels(nodes);
  return nodes;
}

// 列出工作区内全部 Markdown 文件（递归，忽略规则与目录树一致）
// 供发布前的变更扫描使用：返回绝对路径、相对路径与文件名
function listMarkdownFiles() {
  if (!currentWorkspace) return [];
  const results = [];
  const MAX_FILES = 3000;
  const EXTS = /\.(md|markdown|mdx)$/i;
  const excluded = getExcludedSet();

  function walk(dir, depth) {
    if (depth > 12 || results.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (excluded.has(toRel(full))) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && EXTS.test(entry.name)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_err) { continue; }
        if (size > 5 * 1024 * 1024) continue;
        results.push({
          path: full,
          relative: path.relative(currentWorkspace, full).split(path.sep).join('/'),
          name: entry.name,
          size
        });
      }
    }
  }

  walk(currentWorkspace, 0);
  results.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN'));
  return results;
}

// 列出工作区内全部图片文件（递归，忽略规则与目录树一致）
// 供发布前变更扫描使用，确保截图粘贴/文件导入产生的图片也能随文档一起发布。
function listImageFiles() {
  if (!currentWorkspace) return [];
  const results = [];
  const MAX_FILES = 5000;
  const excluded = getExcludedSet();

  function walk(dir, depth) {
    if (depth > 12 || results.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (excluded.has(toRel(full))) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && IMAGE_FILE_RE.test(entry.name)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_err) { continue; }
        if (size > 50 * 1024 * 1024) continue;
        results.push({
          path: full,
          relative: path.relative(currentWorkspace, full).split(path.sep).join('/'),
          name: entry.name,
          size
        });
      }
    }
  }

  walk(currentWorkspace, 0);
  results.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN'));
  return results;
}

function searchDocuments(keyword, options) {
  const query = String(keyword || '').trim();
  if (!currentWorkspace || !query) return [];
  const opts = options || {};
  const limit = Math.min(Number(opts.limit) || 300, 1000);
  const caseSensitive = !!opts.caseSensitive;
  const needle = caseSensitive ? query : query.toLowerCase();
  let regex = null;
  if (opts.regex) {
    try {
      regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new Error(`正则表达式无效：${err.message}`);
    }
  }
  const results = [];
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const excluded = getExcludedSet();

  function walk(dir, depth) {
    if (depth > 12 || results.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (excluded.has(toRel(fullPath))) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && /\.(md|markdown|mdx|txt)$/i.test(entry.name)) {
        let content;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(fullPath, 'utf8');
        } catch (_err) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < limit; i += 1) {
          const original = lines[i];
          const haystack = caseSensitive ? original : original.toLowerCase();
          let column = -1;
          if (regex) {
            regex.lastIndex = 0;
            const match = regex.exec(original);
            if (match) column = match.index;
          } else {
            column = haystack.indexOf(needle);
          }
          if (column < 0) continue;
          const relative = path.relative(currentWorkspace, fullPath).split(path.sep).join('/');
          const contextLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2));
          results.push({
            path: fullPath,
            name: entry.name,
            relative,
            dir: path.posix.dirname(relative) === '.' ? '/' : path.posix.dirname(relative),
            line: i + 1,
            column: column + 1,
            text: original.trim().slice(0, 240),
            context: contextLines.join('\n').trim().slice(0, 300)
          });
        }
      }
    }
  }

  walk(currentWorkspace, 0);
  return results;
}

async function readFile(filePath) {
  const resolved = assertInside(filePath);
  // 读取单个文件时同步登记其目录，保证保存路径被允许（兼容“最近打开”列表中的工作区外文件）
  grantFile(resolved);
  const content = await fs.promises.readFile(resolved, 'utf8');
  return { path: resolved, name: path.basename(resolved), content };
}

async function writeFile(filePath, content) {
  const resolved = assertInside(filePath);
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  await fs.promises.writeFile(resolved, String(content ?? ''), 'utf8');
  return { path: resolved, size: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

async function createFile(dirPath, name) {
  const dir = dirPath ? assertInside(dirPath) : assertInside(currentWorkspace);
  let fileName = String(name || '').trim() || '未命名文档.md';
  if (!/\.md$/i.test(fileName)) fileName += '.md';
  fileName = fileName.replace(/[\\/:*?"<>|]/g, '-');

  const target = assertInside(path.join(dir, fileName));
  try {
    await fs.promises.access(target, fs.constants.F_OK);
    throw new Error(`文件已存在：${fileName}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const title = fileName.replace(/\.md$/i, '');
  await fs.promises.writeFile(target, `# ${title}\n\n`, 'utf8');
  return { path: target, name: fileName };
}

async function createFolder(dirPath, name) {
  const parent = dirPath ? assertInside(dirPath) : assertInside(currentWorkspace);
  let folderName = String(name || '').trim() || '新建文件夹';
  folderName = folderName.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, '新建文件夹');
  const target = assertInside(path.join(parent, folderName));
  if (target === parent) throw new Error('文件夹名称无效。');
  try {
    await fs.promises.mkdir(target);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`文件夹已存在：${folderName}`);
    throw err;
  }
  return { path: target, name: folderName };
}

function revealPath(targetPath) {
  const resolved = assertInside(targetPath);
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch (_err) {
    throw new Error('目标不存在或已被移动。');
  }
  if (isDir) {
    return shell.openPath(resolved).then((failure) => {
      if (failure) throw new Error(`打开文件夹失败：${failure}`);
      return { path: resolved, kind: 'folder' };
    });
  }
  shell.showItemInFolder(resolved);
  return Promise.resolve({ path: resolved, kind: 'file' });
}

// 文件增删/改名后让 VitePress 侧边栏跟随本地文档，避免目录里残留已删除的旧条目。
function syncSidebarForWorkspace() {
  if (!currentWorkspace) return null;
  try {
    const gh = config.getGithubForWorkspace(currentWorkspace);
    return vitepressSidebar.syncSidebar({
      workspace: currentWorkspace,
      files: listMarkdownFiles(),
      pathPrefix: gh && gh.pathPrefix,
      extraFolders: listExcludedDirs().map((dir) => dir.relative)
    });
  } catch (_) {
    return null;
  }
}

async function renamePath(oldPath, newName) {
  const source = assertInside(oldPath);
  let name = String(newName || '').trim();
  if (!name) throw new Error('名称不能为空。');
  name = name.replace(/[\\/:*?"<>|]/g, '-');
  const target = assertInside(path.join(path.dirname(source), name));
  if (source === target) return { path: source, name: path.basename(source) };
  try {
    await fs.promises.access(target, fs.constants.F_OK);
    throw new Error(`已存在同名项目：${name}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const wasDir = (await fs.promises.stat(source)).isDirectory();
  await fs.promises.rename(source, target);
  if (wasDir && currentWorkspace) {
    const rel = (p) => path.relative(currentWorkspace, p).split(path.sep).join('/');
    try {
      const sync = vitepressSidebar.syncFolderRename(currentWorkspace, rel(source), rel(target));
      if (sync && sync.count) return { path: target, name, vitepressSynced: sync.count };
    } catch (_) { /* 同步失败不影响改名本身 */ }
  }
  if (!wasDir) {
    // 文件改名：旧链接移除、新链接插入（文档显示名也随文件名更新）
    const sync = syncSidebarForWorkspace();
    if (sync) return { path: target, name, vitepressSynced: sync.added + sync.removed };
  }
  return { path: target, name };
}

// 在工作区内移动文件或文件夹：目标必须是目录，文件夹不能移进自己的子目录。
// 移动后复用同一套侧边栏同步逻辑（删除旧链接 + 插入新链接 + 清理空目录分组）。
// 链接体检：扫描工作区 Markdown 中的站内链接与图片引用，找出指向不存在文件的失效引用。
// 跳过外链、锚点、邮件、data URI；相对路径按当前文档目录解析，/ 开头按工作区根解析。
function checkLinks(options) {
  if (!currentWorkspace) throw new Error('请先选择工作区文件夹。');
  const files = [];
  function walk(dir, depth) {
    if (depth > 12 || files.length > 3000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (getExcludedSet().has(toRel(full))) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && MD_FILE_RE.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(currentWorkspace, 0);

  const issues = [];
  const SKIP_RE = /^(https?:|mailto:|tel:|data:|#|\/\/)/i;
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const lines = content.split(/\r?\n/);
    let inFence = false;
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const re = /!?\[[^\]]*\]\(([^)]+)\)/g;
      let match;
      while ((match = re.exec(line))) {
        const raw = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '');
        if (!raw || SKIP_RE.test(raw)) continue;
        const target = raw.split('#')[0].split('?')[0];
        if (!target) continue;
        let resolved;
        const isRootPath = target.startsWith('/');
        if (isRootPath) resolved = path.join(currentWorkspace, target.slice(1));
        else resolved = path.resolve(path.dirname(file), target);
        // 尝试常见扩展名与 index.md；VitePress 的 public 目录映射到站点根路径，
        // 因此 /images/x.png 除了 docs/images/x.png，也要检查 docs/public/images/x.png。
        const roots = isRootPath
          ? [currentWorkspace, path.join(currentWorkspace, 'public')]
          : [null];
        const candidates = [];
        for (const root of roots) {
          const base = root ? path.join(root, target.slice(1)) : resolved;
          candidates.push(base, base + '.md', base + '.html',
            path.join(base, 'index.md'), path.join(base, 'README.md'));
        }
        const exists = candidates.some((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
        if (!exists) {
          issues.push({
            file,
            relative: path.relative(currentWorkspace, file).split(path.sep).join('/'),
            line: index + 1,
            target: raw,
            image: match[0].startsWith('!')
          });
        }
      }
    });
  }
  return { issues, scanned: files.length };
}

// 图片目录：VitePress 工作区优先放 public/images，普通工作区放 images
function imageDir() {
  if (!currentWorkspace) throw new Error('请先选择工作区文件夹。');
  const publicDir = path.join(currentWorkspace, 'public');
  const base = fs.existsSync(publicDir) ? path.join(publicDir, 'images') : path.join(currentWorkspace, 'images');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

const MAX_PASTE_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/svg+xml': '.svg'
};

function writeImageBuffer(buffer, ext) {
  const dir = imageDir();
  const suffix = /^\.[a-z0-9]+$/i.test(ext || '') ? ext.toLowerCase() : '.png';
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${suffix}`;
  const target = path.join(dir, name);
  fs.writeFileSync(target, buffer);
  return { path: target, relative: path.relative(currentWorkspace, target).split(path.sep).join('/'), size: buffer.length };
}

// 把剪贴板图片落地为工作区文件，返回绝对路径与相对工作区路径
function saveClipboardImage() {
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) throw new Error('剪贴板中没有图片。');
  return writeImageBuffer(image.toPNG(), '.png');
}

// 从渲染层剪贴板文件读取的 data URL 落地为工作区图片。
// 用于“在桌面复制图片文件 → 编辑器粘贴”这种只有文件引用、没有位图的场景。
function saveImageData(payload) {
  const dataUrl = String((payload && payload.dataUrl) || '');
  const match = /^data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error('剪贴板图片数据格式不支持。');
  const mime = `image/${match[1].toLowerCase()}`;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('剪贴板图片数据为空。');
  if (buffer.length > MAX_PASTE_IMAGE_BYTES) throw new Error('图片超过 50MB，请使用图片按钮导入。');
  const nameExt = path.extname(String((payload && payload.name) || '')).toLowerCase();
  const ext = IMAGE_FILE_RE.test(nameExt) ? nameExt : (IMAGE_MIME_EXT[mime] || '.png');
  return writeImageBuffer(buffer, ext);
}

// 从本地图片文件复制进工作区（工具栏图片按钮用）
function importImageFile(sourcePath) {
  const source = path.resolve(String(sourcePath || ''));
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('图片文件不存在。');
  const dir = imageDir();
  const ext = path.extname(source).toLowerCase() || '.png';
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const target = path.join(dir, name);
  fs.copyFileSync(source, target);
  return { path: target, relative: path.relative(currentWorkspace, target).split(path.sep).join('/'), size: fs.statSync(target).size };
}

async function chooseImageFile() {
  const result = await dialog.showOpenDialog({
    title: '选择要插入的图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return importImageFile(result.filePaths[0]);
}

async function movePath(sourcePath, targetDirPath) {
  const source = assertInside(sourcePath);
  const root = path.resolve(currentWorkspace || source);
  if (source === root) throw new Error('不能移动工作区根目录。');

  let targetDir;
  try {
    targetDir = assertInside(targetDirPath);
  } catch (_) {
    throw new Error('目标文件夹必须在当前工作区内。');
  }
  let targetStat;
  try {
    targetStat = await fs.promises.stat(targetDir);
  } catch (_) {
    throw new Error('目标文件夹不存在。');
  }
  if (!targetStat.isDirectory()) throw new Error('目标位置不是文件夹。');

  const name = path.basename(source);
  const target = path.join(targetDir, name);
  // 移到原位置本身是合法的空操作，需在自嵌套检查之前放行
  if (source === targetDir || source === target) return { path: source, name };

  const sourceStat = await fs.promises.stat(source);
  if (sourceStat.isDirectory()) {
    const rel = path.relative(source, targetDir);
    if (!rel || (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
      throw new Error('不能把文件夹移动到它自己的子目录里。');
    }
  }
  try {
    await fs.promises.access(target, fs.constants.F_OK);
    throw new Error(`目标文件夹中已存在同名项目：${name}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.promises.rename(source, target);
  const sync = syncSidebarForWorkspace();
  return {
    path: target,
    name,
    from: source,
    vitepressSynced: sync ? sync.added + sync.removed : 0
  };
}

async function deletePath(targetPath) {
  const resolved = assertInside(targetPath);
  if (path.resolve(resolved) === path.resolve(currentWorkspace)) {
    throw new Error('不能删除工作区根目录。');
  }
  await shell.trashItem(resolved);
  const sync = syncSidebarForWorkspace();
  return { path: resolved, vitepressSynced: sync ? sync.added + sync.removed : 0 };
}

function restoreLastWorkspace() {
  const saved = config.load().lastWorkspace;
  if (saved) {
    try {
      if (fs.statSync(saved).isDirectory()) currentWorkspace = path.resolve(saved);
    } catch (err) {
      console.warn('[workspace] 上次工作区不可用：', saved);
    }
  }
  return currentWorkspace;
}

module.exports = {
  getWorkspace,
  setWorkspace,
  assertInside,
  grantFile,
  grantDir,
  getDefaultSaveDir,
  listExcludedDirs,
  excludeDir,
  restoreExcludedDir,
  restoreAllExcludedDirs,
  chooseWorkspace,
  openWorkspacePath,
  gitPull,
  chooseSaveDir,
  chooseFile,
  saveAsDialog,
  readTree,
  listMarkdownFiles,
  listImageFiles,
  searchDocuments,
  readFile,
  writeFile,
  createFile,
  createFolder,
  revealPath,
  checkLinks,
  saveClipboardImage,
  saveImageData,
  importImageFile,
  chooseImageFile,
  renamePath,
  movePath,
  deletePath,
  restoreLastWorkspace
};
