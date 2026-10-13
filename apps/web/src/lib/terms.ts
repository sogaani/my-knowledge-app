/**
 * Same as queryTerms in packages/core/src/query.ts (the web bundle cannot import @kb/core: it pulls in bun:sqlite and LanceDB).
 * Whitespace first, then each piece by character class; hiragana runs and 1-char runs are dropped, a trailing ー on a
 * katakana word too. Used to highlight the words the search actually matched on.
 */
const HAN = "\\p{Script=Han}々〆ヵヶ", KATA = "\\p{Script=Katakana}ー", HIRA = "\\p{Script=Hiragana}ー";
const RUN_RE = new RegExp(`[${HAN}]+|[${KATA}]+|[${HIRA}]+|(?:(?![${HAN}${KATA}${HIRA}])[\\p{L}\\p{N}])+(?:['\\-._+#/@](?:(?![${HAN}${KATA}${HIRA}])[\\p{L}\\p{N}])+)*`, "gu");
const HIRA_RE = new RegExp(`^[${HIRA}]+$`, "u");
const KATA_LONG_RE = new RegExp(`^[${KATA}]{3,}ー$`, "u");
const len = (s: string) => [...s].length;

export function queryTerms(text: string): string[] {
  const pieces = text.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    const runs = piece.match(RUN_RE) ?? [];
    const kept = runs.filter((r) => !HIRA_RE.test(r) && len(r) >= 2).map((r) => (KATA_LONG_RE.test(r) ? r.slice(0, -1) : r));
    if (kept.length) out.push(...kept);
    else if (runs.length === 1 && HIRA_RE.test(runs[0]) && len(runs[0]) >= 2) out.push(runs[0]);
  }
  return [...new Set(out.length ? out : pieces)];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One case-insensitive regex over the terms (longest first), or null when there is nothing to mark. */
export function termsRegex(terms: string[]): RegExp | null {
  const t = terms.filter(Boolean);
  return t.length ? new RegExp([...t].sort((a, b) => b.length - a.length).map(esc).join("|"), "giu") : null;
}
