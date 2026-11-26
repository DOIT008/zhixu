'use strict';

const { Menu, shell, app } = require('electron');
const path = require('path');

function buildMenu(getWindow) {
  const send = (action, args) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('menu-action', { action, args: args || {} });
    }
  };

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '选择工作区…', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('workspace:choose') },
        { label: '新建 Markdown 文件', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
        { label: '从模板新建…', click: () => send('file:newFromTemplate') },
        { label: '打开工作区内文件…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file:saveAs') },
        { type: 'separator' },
        { label: '导出为 PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('file:exportPdf') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('edit:undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('edit:redo') },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
        { type: 'separator' },
        { label: '增加缩进', accelerator: 'CmdOrCtrl+]', click: () => send('format:indentIn') },
        { label: '减少缩进', accelerator: 'CmdOrCtrl+[', click: () => send('format:indentOut') },
        { label: '格式刷', click: () => send('format:painter') },
        { label: '清除格式', click: () => send('format:clear') },
        { type: 'separator' },
        { label: '命令面板…', accelerator: 'CmdOrCtrl+K', click: () => send('tools:commandPalette') },
        { label: '查找（当前文档）', accelerator: 'CmdOrCtrl+F', click: () => send('edit:find') },
        { label: '在文档中搜索…', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('edit:search') },
        { label: '写作统计…', click: () => send('tools:writingStats') },
        { label: '发布前体检…', click: () => send('publish:check') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '分屏显示', accelerator: 'CmdOrCtrl+1', click: () => send('view:split') },
        { label: '仅编辑器', accelerator: 'CmdOrCtrl+2', click: () => send('view:editor') },
        { label: '仅预览', accelerator: 'CmdOrCtrl+3', click: () => send('view:preview') },
        { type: 'separator' },
        { label: '放大字号', accelerator: 'CmdOrCtrl+=', click: () => send('view:zoomIn') },
        { label: '缩小字号', accelerator: 'CmdOrCtrl+-', click: () => send('view:zoomOut') },
        { label: '增大行高', click: () => send('view:lineHeightUp') },
        { label: '减小行高', click: () => send('view:lineHeightDown') },
        { label: '显示/隐藏日志', accelerator: 'CmdOrCtrl+`', click: () => send('view:log') },
        { label: '折叠/展开侧边栏', accelerator: 'CmdOrCtrl+B', click: () => send('view:sidebar') },
        { label: '文档关系图谱…', click: () => send('view:graph') },
        { label: '语法演练场…', click: () => send('view:playground') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '语法',
      submenu: [
        { label: '标题', click: () => send('insert:heading') },
        { label: '列表', click: () => send('insert:list') },
        { label: '引用', click: () => send('insert:quote') },
        { label: '链接', click: () => send('insert:link') },
        { label: '图片', click: () => send('insert:image') },
        { label: '代码块', click: () => send('insert:codeblock') },
        { label: '表格', click: () => send('insert:table') },
        { label: '分割线', click: () => send('insert:hr') },
        { type: 'separator' },
        { label: 'YAML Frontmatter', click: () => send('insert:frontmatter') },
        { label: '目录 [[toc]]', click: () => send('insert:toc') },
        { label: '提示容器 tip', click: () => send('insert:tip') },
        { label: '信息容器 info', click: () => send('insert:info') },
        { label: '警告容器 warning', click: () => send('insert:warning') },
        { label: '危险容器 danger', click: () => send('insert:danger') },
        { label: '折叠面板 details', click: () => send('insert:details') },
        { label: '代码组 code-group', click: () => send('insert:codeGroup') },
        { label: '代码块高亮', click: () => send('insert:codeHighlight') },
        { type: 'separator' },
        { label: '打开语法演练场…', click: () => send('view:playground') }
      ]
    },
    {
      label: '发布',
      submenu: [
        { label: '立即保存并发布', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('publish:now') },
        { label: 'GitHub 发布设置…', click: () => send('publish:settings') },
        { label: '打开发布日志', click: () => send('view:log') },
        { type: 'separator' },
        {
          label: '在浏览器打开 GitHub Actions',
          click: () => shell.openExternal('https://github.com/')
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '查看使用说明',
          click: () => {
            const readme = path.join(__dirname, '..', '..', 'README.md');
            shell.openPath(readme).catch(() => shell.openExternal('https://www.markdownguide.org/'));
          }
        },
        { label: 'Markdown 语法指南', click: () => shell.openExternal('https://www.markdownguide.org/basic-syntax/') },
        { label: '检查更新…', click: () => send('app:checkUpdate') }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
