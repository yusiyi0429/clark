const fs = require('node:fs');
const path = require('node:path');

const docs = 'C:\\Users\\10021\\AppData\\Local\\Temp\\claude\\C--Users-10021-Desktop-clark-Tianshu-MVP\\a302227e-a42f-4d52-91de-2b1a7e069704\\scratchpad\\docs';
const imported = JSON.parse(fs.readFileSync(path.join(__dirname, 'missions-2026-09.json'), 'utf8'));
const missions = imported.missions;
const manifest = JSON.parse(fs.readFileSync(path.join(docs, 'manifest.json'), 'utf8'));
const fields = ['title', 'outcome', 'why', 'successEvidence', 'milestones', 'dependencies', 'risk', 'boundaries', 'keyPath', 'resources', 'humanAgentSplit', 'retrospect'];

function normalize(value) {
  return value
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|`/g, '').replace(/(^|\n)\s*#{1,6}\s*/g, '$1')
    .replace(/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/g, '$1')
    .replace(/\s*\|\s*/g, ' ').replace(/\s+·\s+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function missionSection(ownerId, code, source) {
  const n = Number(code.split('-')[1]);
  const startPattern = {
    'sun-mingze': new RegExp(`^# Mission ${n}｜`, 'm'),
    'chen-xinan': new RegExp(`^## Mission Card ${n - 2}｜`, 'm'),
    'liu-renhao': new RegExp(`^# ${n}\\. Mission [ABC]｜`, 'm'),
    'wang-chuangfeng': /^# Mission\s*$/m,
    'qin-mengyi': new RegExp(`^# Mission 07-${n}｜`, 'm'),
    'tang-jujie': new RegExp(`^# [五六七八]、Mission 09-${n}｜`, 'm'),
    'bai-tiantian': new RegExp(`^03-${n} · SEPTEMBER MISSION CARD`, 'm'),
  }[ownerId];
  const match = startPattern.exec(source);
  if (!match) throw new Error(`找不到 Mission 段：${code}`);
  let end = source.length;
  const endingPattern = {
    'sun-mingze': /^# (?:Mission \d+｜|双向依赖)/gm,
    'chen-xinan': /^(?:## Mission Card \d+｜|# 9 月逐日工作拆解)/gm,
    'liu-renhao': /^# \d+\. /gm,
    'wang-chuangfeng': /^# Mission Cards/gm,
    'qin-mengyi': /^# Mission 07-\d+｜/gm,
    'tang-jujie': /^# [六七八九]、/gm,
    'bai-tiantian': /^(?:03-\d+ · SEPTEMBER MISSION CARD|SUPPORTING WORK ·)/gm,
  }[ownerId];
  endingPattern.lastIndex = match.index + match[0].length;
  const next = endingPattern.exec(source);
  if (next) end = next.index;
  if (ownerId === 'wang-chuangfeng') {
    const row = source.slice(match.index, end).split('\n').find(line => line.includes(`| ${n === 1 ? '明确tokenhub第一期需求' : n === 2 ? '完成tokenhub第一期系统设计' : '开发环境依赖项就绪'} |`));
    if (!row) throw new Error(`找不到表格行：${code}`);
    return row;
  }
  return source.slice(match.index, end);
}

let passed = 0;
const failures = [];
if (imported.period !== '2026-09') failures.push('period 不等于 2026-09');
if (new Set(missions.map(x => x.code)).size !== missions.length) failures.push('code 不唯一');
for (const mission of missions) {
  if (mission.code.length > 40 || mission.title.length > 200 || !mission.outcome) failures.push(`${mission.code} 编号/标题长度或必填 Outcome 不合规`);
  for (const field of fields.filter(x => !['title', 'successEvidence', 'milestones'].includes(x))) {
    if (typeof mission[field] !== 'string' || mission[field].length > 4000) failures.push(`${mission.code} ${field} 类型或长度不合规`);
  }
  for (const field of ['successEvidence', 'milestones']) {
    if (!Array.isArray(mission[field]) || mission[field].length > 30 || mission[field].some(x => typeof x !== 'string' || x.length < 1 || x.length > 500)) failures.push(`${mission.code} ${field} 列表长度不合规`);
  }
  const entry = manifest.find(x => x.title === mission.sourceTitle);
  if (!entry || entry.sourceRef !== mission.sourceRef || entry.sourceDocumentId !== mission.sourceDocumentId || entry.sourceRevision !== mission.sourceRevision) {
    failures.push(`${mission.code} source* 与 manifest 不符`);
    continue;
  }
  const source = fs.readFileSync(path.join(docs, path.basename(entry.markdownFile)), 'utf8');
  const section = normalize(missionSection(mission.ownerId, mission.code, source));
  for (const field of fields) {
    const values = Array.isArray(mission[field]) ? mission[field] : [mission[field]];
    for (const [index, value] of values.entries()) {
      if (!value) continue;
      const needle = normalize(value);
      if (section.includes(needle)) passed++;
      else failures.push(`${mission.code} ${field}${Array.isArray(mission[field]) ? `[${index}]` : ''}: ${value.slice(0, 80)}`);
    }
  }
}
console.log(`逐字来源自检：通过 ${passed} 项，失败 ${failures.length} 项`);
for (const failure of failures) console.log(`失败：${failure}`);
if (failures.length) process.exitCode = 1;
