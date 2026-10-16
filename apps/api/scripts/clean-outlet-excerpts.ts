import { Pool } from "pg";
import { RADAR_OUTLETS } from "@warmap/contracts";
import { decodeHtml, extractArticleContent } from "../src/outletSources.js";

/**
 * 一次性清理：修复正文提取前落库的 fullText 发布方（量子位）Signal 原文。
 * 在 apps/api 下执行：`node --env-file=../../.env --import tsx scripts/clean-outlet-excerpts.ts [--dry-run] [--rebuild-images]`
 * - 在正文尾部标记处截断（容器内版权声明 / 分享框 / 注释残留 `-->`），删去 `-->` 行，补全实体解码；
 * - 丢弃位置落在保留段落之外的配图；历史配图位置的 +N 漂移无法还原，保持原样；
 * - evidence_quote 不再逐字出现在新原文里的行跳过并报告；
 * - `--rebuild-images`：只重建配图（清理之后执行）。用修复后的提取器重读原文页，把每张图前一段按去空白文本
 *   唯一匹配到库里原文的段落上；任何一张图匹配不唯一，该行保留原配图并报告。excerpt / evidence_quote 不动；
 * - 可重复执行：已清理的行不再变化；单事务，有变化的行 version + 1。
 */
const TAIL_MARKERS = new Set(["版权所有，未经授权不得以任何形式转载及使用，违者必究。", "扫码分享至朋友圈", "-->"]);

type Image = { src: string; after: number };

function clean(excerpt: string, images: Image[]): { excerpt: string; images: Image[] } {
  // 与阅读器同一分段口径：按空行分段
  const paragraphs = excerpt.split(/\n{2,}/);
  const cut = paragraphs.findIndex((paragraph) => TAIL_MARKERS.has(paragraph.trim()));
  const body = cut < 0 ? paragraphs : paragraphs.slice(0, cut);
  const kept: string[] = [];
  // 旧段落索引 → 新段落索引；清理后变空的段落并入前一段，配图随之前移
  const index = body.map((paragraph) => {
    const text = decodeHtml(paragraph.split("\n").filter((line) => line.trim() !== "-->").join("\n")).trim();
    if (text) kept.push(text);
    return Math.max(0, kept.length - 1);
  });
  return {
    excerpt: kept.join("\n\n"),
    images: images.filter((image) => image.after < body.length).map((image) => ({ src: decodeHtml(image.src), after: index[image.after] })),
  };
}

const squash = (text: string) => text.replace(/\s+/g, "");

async function rebuildImages(url: string, excerpt: string): Promise<{ images: Image[] } | { skip: string }> {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; WarMapRadar/1.0)" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return { skip: `原文页 HTTP ${response.status}` };
  const page = extractArticleContent(await response.text());
  if (!page.text) return { skip: "原文页找不到正文容器" };
  const pageParagraphs = page.text.split(/\n{2,}/).map(squash);
  // 库里原文与阅读器同一分段口径；旧提取在行内标签两侧多出的空格去掉后再比
  const stored = excerpt.split(/\n{2,}/).map(squash);
  const images: Image[] = [];
  for (const image of page.images) {
    const hits = stored.flatMap((paragraph, index) => (paragraph === pageParagraphs[image.after] ? [index] : []));
    if (hits.length !== 1) return { skip: `原文页第 ${image.after} 段在库里原文匹配到 ${hits.length} 处` };
    images.push({ src: image.src, after: hits[0] });
  }
  return { images };
}

const dryRun = process.argv.includes("--dry-run");
const rebuild = process.argv.includes("--rebuild-images");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("missing env DATABASE_URL");
const fullTextOutlets = RADAR_OUTLETS.filter((outlet) => outlet.fullText).map((outlet) => outlet.outletId);

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const rows = (await client.query<{ id: string; source_url: string; excerpt: string; evidence_quote: string; source_images: Image[] }>(
    `SELECT id, source_url, excerpt, evidence_quote, source_images FROM signals
      WHERE source_type = 'outlet' AND source_ref->>'outletId' = ANY($1::text[])
      ORDER BY collected_at, id FOR UPDATE`,
    [fullTextOutlets],
  )).rows;
  const report: Record<string, string>[] = [];
  for (const row of rows) {
    if (rebuild) {
      const rebuilt = await rebuildImages(row.source_url, row.excerpt);
      const changed = "images" in rebuilt && JSON.stringify(rebuilt.images) !== JSON.stringify(row.source_images);
      if (changed && !dryRun) {
        await client.query(
          "UPDATE signals SET source_images = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
          [row.id, JSON.stringify(rebuilt.images)],
        );
      }
      const afters = (images: Image[]) => images.map((image) => image.after).join(",") || "-";
      report.push({
        id: row.id,
        配图: "images" in rebuilt ? `${row.source_images.length} → ${rebuilt.images.length}` : `${row.source_images.length}`,
        段落: "images" in rebuilt ? `${afters(row.source_images)} → ${afters(rebuilt.images)}` : afters(row.source_images),
        结果: "skip" in rebuilt ? `跳过：${rebuilt.skip}` : !changed ? "无变化" : dryRun ? "将更新" : "已更新",
      });
      continue;
    }
    const next = clean(row.excerpt, row.source_images);
    const changed = next.excerpt !== row.excerpt || JSON.stringify(next.images) !== JSON.stringify(row.source_images);
    const quoteKept = next.excerpt.includes(row.evidence_quote);
    const result = !changed ? "无变化" : !quoteKept ? "跳过：evidence_quote 不在新原文内" : dryRun ? "将更新" : "已更新";
    if (changed && quoteKept && !dryRun) {
      await client.query(
        "UPDATE signals SET excerpt = $2, source_images = $3::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
        [row.id, next.excerpt, JSON.stringify(next.images)],
      );
    }
    report.push({
      id: row.id,
      字数: `${row.excerpt.length} → ${next.excerpt.length}`,
      配图: `${row.source_images.length} → ${next.images.length}`,
      结果: result,
    });
  }
  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  if (report.length) console.table(report);
  else console.log("没有 fullText 发布方的 Signal。");
  if (dryRun) console.log("--dry-run：未写入。");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
