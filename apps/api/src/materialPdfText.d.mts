export type PdfTextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
export const PARAGRAPH_GAP_RATIO: number;
export const TYPICAL_GAP_RATIO: number;
export const SHORT_LINE_CHARS: number;
export function pdfPageParagraphs(items: PdfTextItem[]): string[];
export function pdfText(pages: PdfTextItem[][]): string;
