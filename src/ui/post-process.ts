/**
 * Post-process merged assistant message text for Hermes-specific formatting.
 *
 * Hermes conventions differ from standard markdown:
 * - `---` under text = H1 (not H2 as in standard markdown)
 * - `===` under text = H2 (not H1 as in standard markdown)
 * - Tables use `+--+` borders (sometimes `+=+` between header/body) instead of `|---|`
 *
 * GFM (remark-gfm) expects: header row, then a delimiter row, then body rows — not a
 * top/bottom ASCII border before the header. This module converts borders and reorders
 * / trims so tables parse reliably.
 *
 * Highlight “cards” use repeated ═ / = lines around a title; those become GFM blockquotes
 * with a bold title so the UI can style them as panels.
 */

/**
 * Convert Hermes-formatted text to standard markdown.
 */
export function postProcessMessage(text: string): string {
  const lines = text.split("\n");
  const withBanners = convertHighlightBanners(lines);
  const converted = convertHermesLines(withBanners);
  const withTables = normalizeTableRegions(converted);
  return withTables.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Hermes section banners: lines of ═, =, ─, or hyphen (min length). */
function isHighlightSeparator(trimmed: string): boolean {
  if (trimmed.length < 8) return false;
  if (!/^[\s═=─\u2500\u2501\u2013\u2014-]+$/.test(trimmed)) return false;
  return /[═=\u2500\u2501]/.test(trimmed) || /^-{8,}$/.test(trimmed);
}

function escapeBannerTitle(title: string): string {
  return title.replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

/**
 * ═══ / === … title … ═══ → blockquote with bold heading (styled as a card in the UI).
 */
function convertHighlightBanners(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!isHighlightSeparator(trimmed)) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const title = i + 1 < lines.length ? lines[i + 1].trim() : "";
    const sep2 = i + 2 < lines.length ? lines[i + 2].trim() : "";
    const isTripleBanner = Boolean(title && isHighlightSeparator(sep2) && !isHighlightSeparator(title));

    if (isTripleBanner) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      out.push(`> **${escapeBannerTitle(title)}**`);
      out.push(">");
      i += 3;

      while (i < lines.length) {
        const t = lines[i].trim();
        if (isHighlightSeparator(t)) {
          const nt = i + 1 < lines.length ? lines[i + 1].trim() : "";
          const nt2 = i + 2 < lines.length ? lines[i + 2].trim() : "";
          if (nt && !isHighlightSeparator(nt) && isHighlightSeparator(nt2)) {
            out.push("");
            break;
          }
          i++;
          continue;
        }
        const raw = lines[i];
        const body = raw.trimEnd();
        if (body.trim() === "") {
          out.push(">");
        } else {
          out.push(`> ${body.trim()}`);
        }
        i++;
      }
      if (out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      continue;
    }

    if (out.length > 0 && out[out.length - 1].trim() !== "") {
      out.push("");
    }
    out.push("***");
    out.push("");
    i++;
  }

  return out;
}

function convertHermesLines(lines: string[]): string[] {
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // ── Standalone setext heading underlines ───────────────────────────
    if (/^={3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed)) {
      const prevIdx = findPrevNonEmpty(result);
      if (prevIdx >= 0) {
        const prevText = result[prevIdx].trim();
        if (prevText && !prevText.startsWith("#")) {
          const level = trimmed[0] === "-" ? 1 : 2;
          result[prevIdx] = `${"#".repeat(level)} ${prevText}`;
          continue;
        }
      }
      continue;
    }

    // ── ASCII table borders: +------+------+ or +======+======+ ────────
    if (/^\+[+\-=]+\+$/.test(trimmed)) {
      let row = trimmed.replace(/\+/g, "|");
      row = normalizeBorderDashes(row);
      result.push(row);
      continue;
    }

    result.push(raw);
  }

  return result;
}

/**
 * If the row is delimiter-style only, normalize `=` to `-` so GFM accepts it.
 */
function normalizeBorderDashes(pipeRow: string): string {
  const t = pipeRow.trim();
  if (!isDelimiterOnlyRow(t)) return pipeRow;
  return pipeRow.replace(/=/g, "-");
}

/**
 * GFM delimiter row: cells are only colons and min-length runs of `-` / `=`.
 */
function isDelimiterOnlyRow(trimmed: string): boolean {
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const cells = trimmed.slice(1, -1).split("|");
  if (cells.length === 0) return false;
  return cells.every((cell) => {
    const c = cell.trim();
    if (c === "") return true;
    return /^:?[-=]{3,}:?$/.test(c);
  });
}

function isTableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}

/**
 * First row that is a column delimiter (non-delim row above, delim row here).
 * Skips a leading top-border row so we do not treat it as the "first" delimiter.
 */
function firstInnerDelimiterIndex(buffer: string[]): number {
  for (let i = 1; i < buffer.length; i++) {
    if (!isDelimiterOnlyRow(buffer[i].trim())) continue;
    if (isDelimiterOnlyRow(buffer[i - 1].trim())) continue;
    return i;
  }
  return -1;
}

function pipeCount(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

/**
 * Bottom ASCII border: delimiter-only row, non-delim row above, and at least one line after.
 * We take the *last* such index so an inner `|---|---|` between body rows is not treated
 * as the table end when a later closing border exists.
 *
 * If only one line follows the candidate and its pipe count matches the border, skip split
 * (typical single body row after an internal rule row, not “table + tail”).
 */
function findClosingBorderSplitIndex(buffer: string[]): number {
  const firstD = firstInnerDelimiterIndex(buffer);
  if (firstD < 0) return -1;
  let best = -1;
  for (let i = firstD + 1; i < buffer.length; i++) {
    const t = buffer[i].trim();
    if (!isDelimiterOnlyRow(t)) continue;
    const prev = buffer[i - 1].trim();
    if (isDelimiterOnlyRow(prev)) continue;
    if (i + 1 >= buffer.length) continue;
    best = i;
  }
  if (best < 0) return -1;
  const tailLen = buffer.length - best - 1;
  if (tailLen === 1) {
    const borderPc = pipeCount(buffer[best].trim());
    const nextPc = pipeCount(buffer[best + 1].trim());
    if (borderPc === nextPc) return -1;
  }
  return best;
}

/**
 * One run of consecutive `|...|` lines may include a Hermes table plus unrelated pipe-prefixed
 * lines. Split after each closing border so remark-gfm does not keep one giant <table>.
 */
function splitContiguousPipeBuffer(buffer: string[]): string[][] {
  const parts: string[][] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const idx = findClosingBorderSplitIndex(rest);
    if (idx < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, idx + 1));
    rest = rest.slice(idx + 1);
  }
  return parts;
}

/**
 * Drop Hermes top/bottom border rows so the block becomes: header, delimiter, body…
 */
function normalizeHermesTableBlock(block: string[]): string[] {
  if (block.length === 0) return block;
  const lines = [...block];

  while (lines.length >= 2) {
    const a = lines[0].trim();
    const b = lines[1].trim();
    if (isDelimiterOnlyRow(a) && !isDelimiterOnlyRow(b)) {
      lines.shift();
    } else {
      break;
    }
  }

  while (lines.length >= 2) {
    const last = lines[lines.length - 1].trim();
    if (!isDelimiterOnlyRow(last)) break;
    const prev = lines[lines.length - 2].trim();
    if (!isDelimiterOnlyRow(prev)) {
      lines.pop();
    } else {
      lines.pop();
    }
  }

  return lines;
}

function normalizeTableRegions(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isTableLine(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && isTableLine(lines[i])) {
      i++;
    }
    const contiguous = lines.slice(start, i);
    const segments = splitContiguousPipeBuffer(contiguous);
    for (let s = 0; s < segments.length; s++) {
      if (s > 0) {
        out.push("");
      }
      out.push(...normalizeHermesTableBlock(segments[s]));
    }
  }

  return out;
}

function findPrevNonEmpty(lines: string[]): number {
  for (let j = lines.length - 1; j >= 0; j--) {
    if (lines[j].trim() !== "") return j;
  }
  return -1;
}
