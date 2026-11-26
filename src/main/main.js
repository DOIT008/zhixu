'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');

// 产品名由「墨笺」改为「知序」后，继续沿用原有 userData 目录，
// 避免已有配置、草稿、快照与会话因应用名变化而丢失。
app.setPath('userData', path.join(app.getPath('appData'), 'mojian'));

const { registerIpc } = require('./ipc');
const { buildMenu } = require('./menu');
const workspace = require('./workspace');

const PERF = !!process.env.MOJIAN_PERF;
const START = Date.now();
function perf(label) {
  if (PERF) console.log(`[perf] ${label} @${Date.now()} +${Date.now() - START}ms`);
}
perf('main modules loaded');

let mainWindow = null;
let rendererReady = false;
let pendingOpenFiles = [];
// 关闭窗口流程：用户确认后由渲染进程回传，这里才真正放行关闭
let forceClose = false;

// 命令行 / 拖放到图标传入的 .md 文件（Windows 拖放会把路径作为 argv 传入）
function extractMarkdownArgs(argv) {
  const files = [];
  for (const arg of (argv || []).slice(1)) {
    if (!arg || typeof arg !== 'string' || arg.startsWith('-')) continue;
    if (!/\.(md|markdown|mdx)$/i.test(arg)) continue;
    try {
      if (!fs.statSync(arg).isFile()) continue;
    } catch (_err) {
      continue;
    }
    const resolved = path.resolve(arg);
    if (!files.includes(resolved)) files.push(resolved);
  }
  return files;
}

function flushOpenFiles() {
  if (!rendererReady || !pendingOpenFiles.length || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:openFiles', pendingOpenFiles.slice());
  pendingOpenFiles = [];
}

function queueOpenFiles(files) {
  if (!files || !files.length) return;
  // 工作区定位到第一个文件所在目录，并授权全部文件
  try {
    workspace.setWorkspace(path.dirname(files[0]));
  } catch (err) {
    console.warn('[main] 设置工作区失败：', err.message);
  }
  files.forEach((file) => workspace.grantFile(file));
  pendingOpenFiles.push(files);
  flushOpenFiles();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    backgroundColor: '#eef2f7',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  if (process.env.MD_STUDIO_DEBUG || PERF) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer exited]', details);
    });
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[preload error]', preloadPath, error);
    });
  }

  // 拦截渲染进程自行处理的快捷键，避免 Electron/系统默认行为（关闭窗口、原生查找栏等）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!(input.control || input.meta)) return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f' || key === 'h' || key === 'w') {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  perf('window loadFile called');
  mainWindow.once('ready-to-show', () => {
    perf('window ready-to-show');
    mainWindow.show();
    mainWindow.focus();
  });
  // 关闭前先询问渲染进程：有未保存内容则弹自定义确认框，确认后才会再次触发 close
  mainWindow.on('close', (event) => {
    if (forceClose) return;
    if (mainWindow.isDestroyed() || !mainWindow.webContents) return;
    event.preventDefault();
    mainWindow.webContents.send('app:confirmClose');
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 单实例：拖放到已运行实例图标上的文件由 second-instance 事件传入
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const files = extractMarkdownArgs(argv);
    if (files.length) queueOpenFiles(files);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    perf('app ready');
    registerIpc(() => mainWindow);
    perf('ipc registered');
    Menu.setApplicationMenu(buildMenu(() => mainWindow));
    perf('menu built');

    // 渲染进程完成确认（或无需确认）后回传：放行真正的窗口关闭
    ipcMain.on('window:closeConfirm', (_event, confirmed) => {
      if (!confirmed) return;
      forceClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    // 渲染进程就绪后来取待打开的文件（避免启动时事件早于监听器注册）
    ipcMain.handle('app:takeOpenFiles', () => {
      rendererReady = true;
      const all = pendingOpenFiles.slice();
      pendingOpenFiles = [];
      return all;
    });

    createWindow();
    perf('window created');

    // 冷启动拖放到图标：process.argv 携带文件路径
    const startupFiles = extractMarkdownArgs(process.argv);
    if (startupFiles.length) queueOpenFiles(startupFiles);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// 菜单“退出”/Ctrl+Q 走 app.quit()，这里也需要先确认；forceClose 时不重复拦截
app.on('before-quit', (event) => {
  if (forceClose) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
  event.preventDefault();
  mainWindow.webContents.send('app:confirmClose');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
