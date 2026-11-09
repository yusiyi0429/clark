import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 本人已装的飞书技能（lark-* 且有 SKILL.md）；目录读不了就当没有。 */
export function larkSkills(skillsDir: string): string[] {
  try { return readdirSync(skillsDir).filter((n) => n.startsWith("lark-") && existsSync(join(skillsDir, n, "SKILL.md"))); } catch { return []; }
}

/**
 * 岗位的工具里有 feishu 时，给干净会话挂一个只在本会话生效的插件（--plugin-dir）：里面的技能是指向本人已装的 lark-* 技能的目录链接，
 * 不复制、不改本人的配置。11/06 实测：Claude Code 认 --plugin-dir 里经目录链接（junction）指过去的技能，显示为 tianshu-feishu:lark-doc 等。
 * 本人没装飞书技能、或一个链接都建不了时返回 null。整理链接出什么错都不挡开工。
 */
export function ensureFeishuPlugin(dataDir: string, skillsDir: string): string | null {
  const skills = larkSkills(skillsDir);
  if (!skills.length) return null;
  const dir = join(dataDir, "plugins", "tianshu-feishu");
  const linkDir = join(dir, "skills");
  try {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tianshu-feishu", version: "1.0.0", description: "本人已装的飞书技能（天枢本机程序按技能挂载）" }));
  } catch { return null; }
  // 本人删掉的技能，链接也删。unlink 只删链接本身、不进指向的目录（Bun 下 rmSync 删目录链接报 EFAULT）；不是链接的删不掉就留着。
  for (const n of readdirSync(linkDir)) {
    if (!skills.includes(n)) try { unlinkSync(join(linkDir, n)); } catch { /* 不是链接，或被占用 */ }
  }
  let linked = 0;
  for (const n of skills) {
    const link = join(linkDir, n);
    try { lstatSync(link); linked += 1; continue; } catch { /* 还没有 */ }
    try { symlinkSync(join(skillsDir, n), link, "junction"); linked += 1; } catch { /* 建不了就少这一个技能 */ }
  }
  return linked ? dir : null;
}
