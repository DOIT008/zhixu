'use strict';

const { ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const config = require('./config');
const workspace = require('./workspace');

// 发布 / PDF / 历史相关模块只在真正用到时加载，减少冷启动时的模块解析开销。
let githubModule = null;
let sidebarModule = null;
let pdfModule = null;
let historyModule = null;
let backupModule = null;
let reportModule = null;
let graphModule = null;
let templateModule = null;
let updateModule = null;
function getGithub() { if (!githubModule) githubModule = require('./github'); return githubModule; }
function getSidebar() { if (!sidebarModule) sidebarModule = require('./vitepress-sidebar'); return sidebarModule; }
function getPdf() { if (!pdfModule) pdfModule = require('./pdf'); return pdfModule; }
function getHistory() { if (!historyModule) historyModule = require('./history'); return historyModule; }
function getBackup() { if (!backupModule) backupModule = require('./backup'); return backupModule; }
function getReport() { if (!reportModule) reportModule = require('./publish-report'); return reportModule; }
function getGraph() { if (!graphModule) graphModule = require('./graph'); return graphModule; }
function getTemplates() { if (!templateModule) templateModule = require('./templates'); return templateModule; }
function getUpdates() { if (!updateModule) updateModule = require('./updates'); return updateModule; }

function registerIpc(getWindow) {
  const sendToRenderer = (channel, payload) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const publishLogger = (message, level = 'info') => {
    sendToRenderer('publish:log', {
      level,
      message,
      time: new Date().toISOString()
    });
  };

  ipcMain.handle('workspace:restore', () => workspace.restoreLastWorkspace());
  ipcMain.handle('workspace:choose', () => workspace.chooseWorkspace());
  ipcMain.handle('workspace:openPath', (_event, workspacePath) => workspace.openWorkspacePath(workspacePath));
  ipcMain.handle('workspace:gitPull', () => workspace.gitPull());
  ipcMain.handle('workspace:tree', () => workspace.readTree());
  ipcMain.handle('workspace:search', (_event, payload) => {
    const keyword = payload && payload.keyword !== undefined ? payload.keyword : payload;
    const options = payload && payload.options ? payload.options : {};
    return workspace.searchDocuments(keyword, options);
  });
  ipcMain.handle('workspace:current', () => workspace.getWorkspace());
  ipcMain.handle('workspace:defaultSaveDir', () => workspace.getDefaultSaveDir());
  ipcMain.handle('workspace:chooseSaveDir', (_event, defaultPath) => workspace.chooseSaveDir(defaultPath));
  ipcMain.handle('workspace:listExcluded', () => workspace.listExcludedDirs());
  ipcMain.handle('workspace:excludeDir', (_event, dirPath) => workspace.excludeDir(dirPath));
  ipcMain.handle('workspace:restoreExcluded', (_event, rel) => workspace.restoreExcludedDir(rel));
  ipcMain.handle('workspace:restoreAllExcluded', () => workspace.restoreAllExcludedDirs());
  ipcMain.handle('workspace:openFileDialog', () => workspace.chooseFile());
  ipcMain.handle('workspace:grantPath', (_event, filePath) => workspace.grantFile(filePath));
  ipcMain.handle('workspace:readFile', (_event, filePath) => workspace.readFile(filePath));
  ipcMain.handle('workspace:writeFile', (_event, payload) => {
    const filePath = typeof payload === 'string' ? payload : payload.filePath;
    const content = typeof payload === 'string' ? '' : payload.content;
    return workspace.writeFile(filePath, content);
  });
  ipcMain.handle('workspace:createFile', (_event, payload) => {
    const dirPath = payload && payload.dirPath;
    const name = payload && payload.name;
    return workspace.createFile(dirPath, name);
  });
  ipcMain.handle('workspace:createFolder', (_event, payload) => {
    const dirPath = payload && payload.dirPath;
    const name = payload && payload.name;
    return workspace.createFolder(dirPath, name);
  });
  ipcMain.handle('workspace:reveal', (_event, targetPath) => workspace.revealPath(targetPath));
  ipcMain.handle('workspace:checkLinks', () => workspace.checkLinks());
  ipcMain.handle('image:paste', () => workspace.saveClipboardImage());
  ipcMain.handle('image:pasteFile', (_event, payload) => workspace.saveImageData(payload));
  ipcMain.handle('image:choose', () => workspace.chooseImageFile());
  ipcMain.handle('workspace:rename', (_event, payload) => {
    const oldPath = payload && payload.oldPath;
    const newName = payload && payload.newName;
    return workspace.renamePath(oldPath, newName);
  });
  ipcMain.handle('workspace:move', (_event, payload) => {
    const sourcePath = payload && payload.sourcePath;
    const targetDir = payload && payload.targetDir;
    return workspace.movePath(sourcePath, targetDir);
  });
  ipcMain.handle('workspace:delete', (_event, targetPath) => workspace.deletePath(targetPath));
  ipcMain.handle('dialog:saveAs', (_event, payload) => workspace.saveAsDialog(payload && payload.defaultPath));
  ipcMain.handle('export:pdf', (_event, payload) => getPdf().exportPdf(payload || {}));

  ipcMain.handle('history:saveSnapshot', (_event, payload) => {
    const item = getHistory().saveSnapshot(payload && payload.filePath, payload && payload.content, payload && payload.label);
    const limit = (config.load().editor || {}).snapshotLimit || 40;
    getHistory().prune(payload && payload.filePath, limit);
    return item;
  });
  ipcMain.handle('history:list', (_event, payload) => {
    const filePath = typeof payload === 'string' ? payload : (payload && payload.filePath);
    const limit = typeof payload === 'object' && payload && payload.limit ? payload.limit : undefined;
    return getHistory().listSnapshots(filePath, limit);
  });
  ipcMain.handle('history:read', (_event, snapshotId) => getHistory().readSnapshot(snapshotId));

  ipcMain.handle('config:get', () => config.load());
  ipcMain.handle('config:save', (_event, cfg) => config.save(cfg));
  // GitHub 配置按工作区隔离：设置弹窗读写的是当前文件夹对应的仓库配置（扁平 github 对象）
  ipcMain.handle('github:getConfig', () => config.getGithubForWorkspace(workspace.getWorkspace()).github);
  ipcMain.handle('github:saveConfig', (_event, gh) => config.saveGithubForWorkspace(workspace.getWorkspace(), gh));
  // 权限自检：直接用表单当前填写的配置（含未保存的改动）测试，避免保存后才发现问题
  ipcMain.handle('github:checkAccess', async (_event, payload) => {
    const gh = payload && payload.github;
    return getGithub().checkAccess({
      config: { github: gh },
      logger: (message) => publishLogger(message, 'info')
    });
  });

  ipcMain.handle('github:publish', async (_event, payload) => {
    const filePath = payload && payload.filePath;
    const content = payload && payload.content;
    if (!filePath) throw new Error('没有可发布的文件，请先保存。');
    return getGithub().publishFile({
      config: config.getGithubForWorkspace(workspace.getWorkspace()),
      workspace: workspace.getWorkspace(),
      filePath,
      content,
      logger: (message) => publishLogger(message, 'info')
    });
  });

  ipcMain.handle('github:scanChanges', async (_event, payload) => {
    const ws = workspace.getWorkspace();
    const cfg = config.getGithubForWorkspace(ws);
    const files = workspace.listMarkdownFiles();
    const assetFiles = workspace.listImageFiles();
    const extraFiles = [];
    // 只有用户主动打开发布预览时才同步侧边栏；后台徽标扫描不改动任何文件
    if (payload && payload.syncSidebar && ws) {
      try {
        const result = getSidebar().syncSidebar({
          workspace: ws,
          files,
          pathPrefix: cfg && cfg.pathPrefix,
          extraFolders: workspace.listExcludedDirs().map((dir) => dir.relative),
          logger: (message, level) => publishLogger(message, level || 'info')
        });
        if (result && result.file) {
          extraFiles.push({
            path: result.file,
            relative: path.relative(ws, result.file).split(path.sep).join('/')
          });
        }
      } catch (err) {
        publishLogger(`VitePress 侧边栏同步失败：${err.message}`, 'warn');
      }
    }
    return getGithub().scanChanges({
      config: cfg,
      workspace: ws,
      files,
      assetFiles,
      extraFiles,
      logger: (message) => publishLogger(message, 'info')
    });
  });

  ipcMain.handle('github:diff', async (_event, payload) => {
    const cfg = config.getGithubForWorkspace(workspace.getWorkspace());
    return getGithub().getFileDiff({
      config: cfg,
      workspace: workspace.getWorkspace(),
      change: payload && payload.change,
      logger: (message) => publishLogger(message, 'info')
    });
  });

  ipcMain.handle('github:publishBatch', async (_event, payload) => {
    const cfg = config.getGithubForWorkspace(workspace.getWorkspace());
    return getGithub().publishBatch({
      config: cfg,
      workspace: workspace.getWorkspace(),
      selections: payload && payload.selections,
      logger: (message) => publishLogger(message, 'info')
    });
  });

  // 撤销单个变更：本地恢复为线上版本
  ipcMain.handle('github:revertChange', async (_event, payload) => {
    const cfg = config.getGithubForWorkspace(workspace.getWorkspace());
    return getGithub().revertChange({
      config: cfg,
      workspace: workspace.getWorkspace(),
      change: payload && payload.change,
      logger: (message) => publishLogger(message, 'info')
    });
  });

  // 草稿备份：崩溃恢复用的未提交内容，默认只写 userData/drafts
  ipcMain.handle('draft:save', (_event, payload) => getBackup().saveDraft(payload || {}));
  ipcMain.handle('draft:list', () => getBackup().listDrafts());
  ipcMain.handle('draft:read', (_event, id) => getBackup().readDraft(id));
  ipcMain.handle('draft:delete', (_event, id) => getBackup().deleteDraft(id));
  ipcMain.handle('draft:deleteByPath', (_event, filePath) => getBackup().deleteDraftByPath(filePath));

  // 发布前体检 / 关系图谱 / 模板 / 更新检查
  ipcMain.handle('publish:check', () => getReport().run());
  ipcMain.handle('graph:build', () => getGraph().build());
  ipcMain.handle('template:list', () => getTemplates().list());
  ipcMain.handle('template:folder', () => getTemplates().openFolder());
  ipcMain.handle('app:checkUpdate', () => getUpdates().check());
  ipcMain.handle('app:openExternal', (_event, targetUrl) => {
    const value = String(targetUrl || '');
    if (!/^https:\/\//i.test(value)) return false;
    shell.openExternal(value).catch(() => {});
    return true;
  });

  ipcMain.handle('app:copyText', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('app:log', (_event, payload) => {
    const level = payload && payload.level ? payload.level : 'info';
    const message = payload && payload.message ? payload.message : String(payload);
    if (level === 'error') console.error('[renderer]', message);
    else console.log('[renderer]', message);
    publishLogger(message, level);
  });

  ipcMain.on('window:minimize', () => {
    const win = getWindow && getWindow();
    if (win) win.minimize();
  });
  ipcMain.on('window:maximize', () => {
    const win = getWindow && getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => {
    const win = getWindow && getWindow();
    if (win) win.close();
  });
}

module.exports = { registerIpc };
