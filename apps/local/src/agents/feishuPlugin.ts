import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 岗位的工具里有 feishu 时，给干净会话挂一个只在本会话生效的插件（--plugin-dir）：里面的技能是指向本人已装的 lark-* 技能的目录链接，
 * 不复制、不改本人的配置。11/06 实测：Claude Code 认 --plugin-dir 里经目录链接（junction）指过去的技能，显示为 tianshu-feishu:lark-doc 等。
 * 本人没装飞书技能时返回 null。
 */
export function ensureFeishuPlugin(dataDir: string, skillsDir: string): string | null {
  let skills: string[];
  try { skills = readdirSync(skillsDir).filter((n) => n.startsWith("lark-") && existsSync(join(skillsDir, n, "SKILL.md"))); } catch { return null; }
  if (!skills.length) return null;
  const dir = join(dataDir, "plugins", "tianshu-feishu");
  const linkDir = join(dir, "skills");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tianshu-feishu", version: "1.0.0", description: "本人已装的飞书技能（天枢本机程序按岗位挂载）" }));
  // 本人删掉的技能，链接也删；只删链接本身，不碰链接指向的目录。
  for (const n of readdirSync(linkDir)) if (!skills.includes(n)) rmSync(join(linkDir, n), { force: true });
  for (const n of skills) {
    const link = join(linkDir, n);
    let exists = false;
    try { exists = lstatSync(link).isSymbolicLink(); } catch { /* 还没有 */ }
    if (!exists) symlinkSync(join(skillsDir, n), link, "junction");
  }
  return dir;
}
