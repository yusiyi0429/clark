// 测试里现做 Word / Excel 文件：自己拼 zip 和 XML，不碰本人的真实文档。
import { crc32, deflateRawSync } from "node:zlib";

export type Part = [name: string, content: string | Buffer];

/** 拼一个 zip。store=true 时不压缩（另一种写法），其余照常 deflate。 */
export function makeZip(parts: Part[], opts: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const comp = opts.store ? data : deflateRawSync(data);
    const method = opts.store ? 0 : 8;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * 拼一个 .docx。body 是 <w:body> 里面的 XML；styles / numbering 不给就用默认的。
 * prefix 换掉 w: 前缀（模拟别的软件写出来的文件）。
 */
export function makeDocx(body: string, opts: { styles?: string; numbering?: string; prefix?: string; store?: boolean; reverse?: boolean; extra?: Part[] } = {}): Buffer {
  const pre = (xml: string) => (opts.prefix ? xml.replace(/(<\/?)w:/g, `$1${opts.prefix}:`).replace(/ w:/g, ` ${opts.prefix}:`).replace(/xmlns:w=/g, `xmlns:${opts.prefix}=`) : xml);
  const parts: Part[] = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/numbering" Target="/word/numbering.xml"/></Relationships>`],
    ["word/document.xml", pre(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`)],
    ["word/styles.xml", pre(`<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${opts.styles ?? DEFAULT_STYLES}</w:styles>`)],
    ["word/numbering.xml", pre(`<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>${opts.numbering ?? DEFAULT_NUMBERING}</w:numbering>`)],
    ...(opts.extra ?? []),
  ];
  return makeZip(opts.reverse ? parts.reverse() : parts, { store: opts.store });
}

export const DEFAULT_STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';

export const DEFAULT_NUMBERING =
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export interface SheetSpec { name: string; data?: string; state?: string; chart?: boolean; file?: string; after?: string }

/**
 * 拼一个 .xlsx。每张表给 sheetData 里面的 XML（data）和 sheetData 后面的（after，比如合并格子）。
 * styles 是 styles.xml 里 <styleSheet> 下面的内容；默认第 1 号样式是日期（内置 14）。
 */
export function makeXlsx(sheets: SheetSpec[], opts: { strings?: string[]; styles?: string; date1904?: boolean; store?: boolean; reverse?: boolean; extra?: Part[] } = {}): Buffer {
  const target = (s: SheetSpec, i: number) => s.file ?? (s.chart ? `chartsheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`);
  const parts: Part[] = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ["_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8"?><workbook ${S}>${opts.date1904 ? '<workbookPr date1904="1"/>' : "<workbookPr/>"}<sheets>` +
        sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 10}"/>`).join("") +
        "</sheets></workbook>",
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
        sheets.map((s, i) => `<Relationship Id="rId${i + 10}" Type="${REL}/${s.chart ? "chartsheet" : "worksheet"}" Target="${target(s, i)}"/>`).join("") +
        "</Relationships>",
    ],
    ["xl/sharedStrings.xml", `<sst ${S} count="${opts.strings?.length ?? 0}">${(opts.strings ?? []).map((t) => `<si><t xml:space="preserve">${t}</t></si>`).join("")}</sst>`],
    ["xl/styles.xml", `<styleSheet ${S}>${opts.styles ?? DEFAULT_XLSX_STYLES}</styleSheet>`],
    ...sheets.map((s, i): Part => [`xl/${target(s, i)}`, s.chart ? `<chartsheet ${S}/>` : `<worksheet ${S}><dimension ref="A1"/><sheetData>${s.data ?? ""}</sheetData>${s.after ?? ""}</worksheet>`]),
    ...(opts.extra ?? []),
  ];
  return makeZip(opts.reverse ? parts.reverse() : parts, { store: opts.store });
}

export const DEFAULT_XLSX_STYLES = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>';

/** 一段普通文字。 */
export function p(text: string, pPr = ""): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** 前后两份文字不一样的那一段（去掉相同的开头和结尾）。 */
export function changedSpan(a: string, b: string): { before: string; after: string } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { before: a.slice(s, a.length - e), after: b.slice(s, b.length - e) };
}
