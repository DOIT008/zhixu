'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, dialog } = require('electron');
const { pathToFileURL } = require('url');

function safeFileName(name) {
  return String(name || 'document').replace(/[\\/:*?"<>|]/g, '-').replace(/\.[^.]+$/, '') || 'document';
}

function buildPrintDocument(previewHtml, fontSize) {
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const fontPath = path.join(rendererDir, 'assets', 'fonts', 'JetBrainsMapleMono-Regular.ttf');
  let css = '';
  try {
    css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  } catch (_err) {
    css = '';
  }
  // 打包后字体在 asar 内，转成绝对 file URL 才能在临时打印页里加载
  css = css.replace(/url\(["']?assets\/fonts\/([^"')]+)["']?\)/g, (_match, file) => {
    const resolved = path.join(rendererDir, 'assets', 'fonts', file);
    return `url("${pathToFileURL(resolved).href}")`;
  });

  const printCss = `
@page { size: A4; margin: 18mm 16mm 20mm; }
html, body {
  height: auto !important; overflow: visible !important;
  background: #fff !important; color: #1e293b !important;
}
body::before { display: none !important; }
.markdown-body {
  max-width: none; margin: 0; padding: 0;
  font-size: ${Number(fontSize) || 15}px; line-height: 1.75;
  color: #1e293b; background: #fff;
}
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 { break-after: avoid-page; }
.markdown-body pre, .markdown-body table, .markdown-body blockquote,
.markdown-body .vp-admonition, .markdown-body .vp-code-block { break-inside: avoid; }
.markdown-body pre { white-space: pre-wrap; word-break: break-word; }
.markdown-body img { max-width: 100%; }
.markdown-body a { color: #087f52; }
.markdown-body .vp-code-panel { display: block !important; }
.markdown-body .vp-code-tabs { display: none !important; }
`;

  return {
    html: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>导出预览</title><style>${css}\n${printCss}</style></head><body><article class="markdown-body">${previewHtml}</article></body></html>`,
    fontAvailable: fs.existsSync(fontPath)
  };
}

async function exportPdf({ html, title, fontSize, docTitle }) {
  const result = await dialog.showSaveDialog({
    title: '导出为 PDF',
    defaultPath: path.join(app.getPath('documents'), `${safeFileName(title || docTitle)}.pdf`),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const document = buildPrintDocument(String(html || ''), fontSize);
  const tempFile = path.join(os.tmpdir(), `markdown-studio-print-${process.pid}-${Date.now()}.html`);
  await fs.promises.writeFile(tempFile, document.html, 'utf8');

  const printWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
  });

  try {
    await printWindow.loadFile(tempFile);
    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginType: 'custom',
      marginTop: 0.72,
      marginBottom: 0.78,
      marginLeft: 0.66,
      marginRight: 0.66,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#94a3b8;font-family:sans-serif;">第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>'
    });
    await fs.promises.writeFile(result.filePath, pdfBuffer);
    return { canceled: false, filePath: result.filePath, size: pdfBuffer.length };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await fs.promises.unlink(tempFile).catch(() => {});
  }
}

module.exports = { exportPdf };
