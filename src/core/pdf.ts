// Minimal text-only PDF writer — no dependencies, deterministic output.
// Letter pages, Courier (fixed-width) so no font metrics are needed.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const FONT_SIZE = 9;
const LEADING = 12;
const CHAR_W = FONT_SIZE * 0.6; // Courier advance width
export const PDF_COLS = Math.floor((PAGE_W - 2 * MARGIN) / CHAR_W); // ~85
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);   // ~57

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// ASCII-safe: PDF core fonts are Latin-1; replace non-ASCII so the doc is valid.
function toLatin(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

export function wrapText(line: string, width = PDF_COLS): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(" ", width) > 0 ? rest.lastIndexOf(" ", width) : width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  if (rest.length) out.push(rest);
  return out;
}

export function buildPdf(title: string, rawLines: string[]): Uint8Array {
  const lines: string[] = [];
  for (const l of rawLines) lines.push(...wrapText(toLatin(l)));

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (!pages.length) pages.push([""]);

  // Object numbering: 1 catalog, 2 pages, 3 font, then per page: page obj + content obj.
  const objects: string[] = [];
  const nPages = pages.length;
  const pageObjIds: number[] = pages.map((_, i) => 4 + i * 2);
  const contentObjIds: number[] = pages.map((_, i) => 5 + i * 2);

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${nPages} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`;

  for (let i = 0; i < nPages; i++) {
    objects[pageObjIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`;
    const y0 = PAGE_H - MARGIN;
    const cmds = [`BT /F1 ${FONT_SIZE} Tf ${LEADING} TL ${MARGIN} ${y0} Td`];
    for (const [li, line] of pages[i]!.entries()) {
      if (li === 0) cmds.push(`(${esc(line)}) Tj`);
      else cmds.push(`T* (${esc(line)}) Tj`);
    }
    cmds.push("ET");
    const stream = cmds.join("\n");
    objects[contentObjIds[i]!] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  const push = (s: string) => {
    const b = enc.encode(s);
    parts.push(b);
    cursor += b.length;
  };
  push(`%PDF-1.4\n% ${toLatin(title).slice(0, 80)}\n`);
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = cursor;
    push(`${i} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefStart = cursor;
  const count = objects.length;
  push(`xref\n0 ${count}\n`);
  push(`0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) {
    push(`${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
