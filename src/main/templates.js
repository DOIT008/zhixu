'use strict';

// 文档模板：内置常用写作骨架，并支持在 userData/templates 下放自定义 .md 文件。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BUILTIN = [
  {
    id: 'meeting',
    name: '会议纪要',
    description: '背景、结论、待办三件事，适合项目例会。',
    content: [
      '---',
      'title: 会议纪要',
      'date: ',
      '---',
      '',
      '# 会议纪要',
      '',
      '## 基本信息',
      '',
      '- 时间：',
      '- 参与人：',
      '- 主题：',
      '',
      '## 背景与目标',
      '',
      '',
      '## 讨论要点',
      '',
      '- ',
      '',
      '## 结论',
      '',
      '- ',
      '',
      '## 待办事项',
      '',
      '- [ ] 负责人 / 事项 / 截止时间',
      ''
    ].join('\n')
  },
  {
    id: 'weekly',
    name: '周报',
    description: '本周进展、问题、下周计划。',
    content: [
      '---',
      'title: 周报',
      'date: ',
      '---',
      '',
      '# 周报',
      '',
      '## 本周完成',
      '',
      '- ',
      '',
      '## 进行中',
      '',
      '- ',
      '',
      '## 遇到的问题',
      '',
      '- ',
      '',
      '## 下周计划',
      '',
      '- [ ] ',
      ''
    ].join('\n')
  },
  {
    id: 'tech-design',
    name: '技术设计',
    description: '目标、方案、风险与验收标准。',
    content: [
      '---',
      'title: 技术设计',
      'date: ',
      '---',
      '',
      '# 技术设计',
      '',
      '## 背景与问题',
      '',
      '',
      '## 目标',
      '',
      '- ',
      '',
      '## 方案设计',
      '',
      '### 核心思路',
      '',
      '',
      '### 关键流程',
      '',
      '',
      '### 数据结构 / 接口',
      '',
      '```ts',
      '',
      '```',
      '',
      '## 备选方案',
      '',
      '- ',
      '',
      '## 风险与限制',
      '',
      '- ',
      '',
      '## 验收标准',
      '',
      '- [ ] ',
      ''
    ].join('\n')
  },
  {
    id: 'reading',
    name: '读书笔记',
    description: '摘录、观点、行动清单。',
    content: [
      '---',
      'title: 读书笔记',
      'date: ',
      '---',
      '',
      '# 读书笔记',
      '',
      '- 书名：',
      '- 作者：',
      '- 阅读时间：',
      '',
      '## 一句话概括',
      '',
      '',
      '## 关键摘录',
      '',
      '> ',
      '',
      '## 我的理解',
      '',
      '',
      '## 可以立刻做的事',
      '',
      '- [ ] ',
      ''
    ].join('\n')
  }
];

function customDir() {
  return path.join(app.getPath('userData'), 'templates');
}

function list() {
  const items = BUILTIN.map((item) => ({ ...item, builtin: true }));
  try {
    fs.mkdirSync(customDir(), { recursive: true });
    for (const name of fs.readdirSync(customDir())) {
      if (!/\.md$/i.test(name)) continue;
      const full = path.join(customDir(), name);
      try {
        const content = fs.readFileSync(full, 'utf8');
        const first = content.split(/\r?\n/).find((line) => /^#\s+/.test(line));
        items.push({
          id: `custom:${name}`,
          name: first ? first.replace(/^#\s+/, '').trim() : path.basename(name, '.md'),
          description: `自定义模板 · ${name}`,
          content,
          builtin: false
        });
      } catch (_err) { /* 忽略无法读取的模板 */ }
    }
  } catch (_err) { /* 自定义模板目录不可用时使用内置模板 */ }
  return items;
}

function openFolder() {
  const dir = customDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { list, openFolder };
