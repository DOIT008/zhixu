'use strict';

// 编辑器自研的行内扩展语法在 VitePress 中不被识别，发布时转换为
// VitePress（markdown-it，默认允许内联 HTML）可正常渲染的 HTML。
// 只处理正文行，跳过 frontmatter 与代码块，避免误改示例代码。

function escapeInlineText(text) {
  return String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function convertInline(line) {
  let out = line;
  out = out.replace(/\{color:(#[0-9a-fA-F]{3,8})\|([^}\n]+)\}/g,
    (_m, color, text) => `<span style="color:${color}">${escapeInlineText(text)}</span>`);
  out = out.replace(/\{bg:(#[0-9a-fA-F]{3,8})\|([^}\n]+)\}/g,
    (_m, color, text) => `<mark style="background-color:${color}">${escapeInlineText(text)}</mark>`);
  out = out.replace(/\{grad:(#[0-9a-fA-F]{3,8},#[0-9a-fA-F]{3,8})\|([^}\n]+)\}/g,
    (_m, pair, text) => `<span style="background-image:linear-gradient(135deg,${pair});color:transparent;-webkit-background-clip:text;background-clip:text;font-weight:600">${escapeInlineText(text)}</span>`);
  out = out.replace(/==(#[0-9a-fA-F]{3,8})\|([^=\n]+)==/g,
    (_m, color, text) => `<mark style="background-color:${color}">${escapeInlineText(text)}</mark>`);
  out = out.replace(/\{align:(left|center|right|justify)\|([^}\n]+)\}/g,
    (_m, align, text) => `<div style="text-align:${align}">${escapeInlineText(text)}</div>`);
  out = out.replace(/==([^=\n]+)==/g,
    (_m, text) => `<mark>${escapeInlineText(text)}</mark>`);
  out = out.replace(/\+\+([^+\n]+)\+\+/g,
    (_m, text) => `<u>${escapeInlineText(text)}</u>`);
  // 上标 ^文字^ / 下标 ~文字~ → VitePress 可渲染的 HTML
  // 下标要避开删除线 ~~…~~（删除线 markdown-it 原生支持，保留原样）
  out = out.replace(/\^([^\^\n]+)\^/g,
    (_m, text) => `<sup>${escapeInlineText(text)}</sup>`);
  out = out.replace(/(^|[^~])~([^~\n]+)~(?!~)/g,
    (_m, lead, text) => `${lead}<sub>${escapeInlineText(text)}</sub>`);
  return out;
}

function toVitepressMarkdown(source) {
  const lines = String(source ?? '').split('\n');

  let fmEnd = -1;
  if (/^\s*---\s*$/.test(lines[0] || '')) {
    for (let i = 1; i < Math.min(lines.length, 60); i += 1) {
      if (/^\s*(---|\.\.\.)\s*$/.test(lines[i])) { fmEnd = i; break; }
    }
  }

  let fence = '';
  let mathBlock = false;
  let changed = false;
  const out = lines.map((line, index) => {
    if (fmEnd >= 0 && index <= fmEnd) return line;

    // 公式块 $$…$$ 内的内容（含 ^ ~ 等 LaTeX 符号）不能做上标/下标转换
    if (mathBlock) {
      if (/^\s*\$\$\s*$/.test(line)) mathBlock = false;
      return line;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      mathBlock = true;
      return line;
    }
    // 单行 $$\公式$$ 整体跳过
    if (/^\s*\$\$.+\$\$\s*$/.test(line)) return line;

    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const closes = fenceMatch && fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length;
      if (closes) fence = '';
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[2];
      return line;
    }

    const converted = convertInline(line);
    if (converted !== line) changed = true;
    return converted;
  });

  return { content: out.join('\n'), changed };
}

module.exports = { toVitepressMarkdown };
