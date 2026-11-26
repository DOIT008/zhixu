'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set(['menu-action', 'publish:log', 'app:openFiles', 'app:confirmClose']);

contextBridge.exposeInMainWorld('mdStudio', {
  platform: process.platform,
  perfEnabled: !!process.env.MOJIAN_PERF,

  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel, payload) {
    ipcRenderer.send(channel, payload);
  },
  on(channel, callback) {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`不允许监听的频道：${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // 语义化快捷方法
  takeOpenFiles: () => ipcRenderer.invoke('app:takeOpenFiles'),
  restoreWorkspace: () => ipcRenderer.invoke('workspace:restore'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: (workspacePath) => ipcRenderer.invoke('workspace:openPath', workspacePath),
  gitPull: () => ipcRenderer.invoke('workspace:gitPull'),
  getTree: () => ipcRenderer.invoke('workspace:tree'),
  searchDocuments: (keyword, options) => ipcRenderer.invoke('workspace:search', { keyword, options: options || {} }),
  exportPdf: (payload) => ipcRenderer.invoke('export:pdf', payload),
  getCurrentWorkspace: () => ipcRenderer.invoke('workspace:current'),
  getDefaultSaveDir: () => ipcRenderer.invoke('workspace:defaultSaveDir'),
  chooseSaveDir: (defaultPath) => ipcRenderer.invoke('workspace:chooseSaveDir', defaultPath),
  listExcludedDirs: () => ipcRenderer.invoke('workspace:listExcluded'),
  excludeDir: (dirPath) => ipcRenderer.invoke('workspace:excludeDir', dirPath),
  restoreExcludedDir: (rel) => ipcRenderer.invoke('workspace:restoreExcluded', rel),
  restoreAllExcludedDirs: () => ipcRenderer.invoke('workspace:restoreAllExcluded'),
  openFileDialog: () => ipcRenderer.invoke('workspace:openFileDialog'),
  grantPath: (filePath) => ipcRenderer.invoke('workspace:grantPath', filePath),
  readFile: (filePath) => ipcRenderer.invoke('workspace:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('workspace:writeFile', { filePath, content }),
  createFile: (dirPath, name) => ipcRenderer.invoke('workspace:createFile', { dirPath, name }),
  createFolder: (dirPath, name) => ipcRenderer.invoke('workspace:createFolder', { dirPath, name }),
  revealPath: (targetPath) => ipcRenderer.invoke('workspace:reveal', targetPath),
  checkLinks: () => ipcRenderer.invoke('workspace:checkLinks'),
  pasteImage: () => ipcRenderer.invoke('image:paste'),
  pasteImageFile: (payload) => ipcRenderer.invoke('image:pasteFile', payload),
  chooseImage: () => ipcRenderer.invoke('image:choose'),
  renamePath: (oldPath, newName) => ipcRenderer.invoke('workspace:rename', { oldPath, newName }),
  movePath: (sourcePath, targetDir) => ipcRenderer.invoke('workspace:move', { sourcePath, targetDir }),
  deletePath: (targetPath) => ipcRenderer.invoke('workspace:delete', targetPath),
  saveAsDialog: (defaultPath) => ipcRenderer.invoke('dialog:saveAs', { defaultPath }),
  saveSnapshot: (filePath, content, label) => ipcRenderer.invoke('history:saveSnapshot', { filePath, content, label }),
  listSnapshots: (filePath, limit) => ipcRenderer.invoke('history:list', { filePath, limit }),
  readSnapshot: (snapshotId) => ipcRenderer.invoke('history:read', snapshotId),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  getGithubConfig: () => ipcRenderer.invoke('github:getConfig'),
  saveGithubConfig: (gh) => ipcRenderer.invoke('github:saveConfig', gh),
  checkGithubAccess: (gh) => ipcRenderer.invoke('github:checkAccess', { github: gh }),
  publish: (filePath, content) => ipcRenderer.invoke('github:publish', { filePath, content }),
  scanPublishChanges: (options) => ipcRenderer.invoke('github:scanChanges', options),
  getPublishDiff: (change) => ipcRenderer.invoke('github:diff', { change }),
  publishBatch: (selections) => ipcRenderer.invoke('github:publishBatch', { selections }),
  revertPublishChange: (change) => ipcRenderer.invoke('github:revertChange', { change }),
  log: (message, level) => ipcRenderer.invoke('app:log', { message, level }),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),
  saveDraft: (filePath, content) => ipcRenderer.invoke('draft:save', { filePath, content }),
  listDrafts: () => ipcRenderer.invoke('draft:list'),
  readDraft: (id) => ipcRenderer.invoke('draft:read', id),
  deleteDraft: (id) => ipcRenderer.invoke('draft:delete', id),
  deleteDraftByPath: (filePath) => ipcRenderer.invoke('draft:deleteByPath', filePath),
  checkPublish: () => ipcRenderer.invoke('publish:check'),
  buildGraph: () => ipcRenderer.invoke('graph:build'),
  listTemplates: () => ipcRenderer.invoke('template:list'),
  openTemplateFolder: () => ipcRenderer.invoke('template:folder'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  confirmClose: (confirmed) => ipcRenderer.send('window:closeConfirm', !!confirmed)
});
