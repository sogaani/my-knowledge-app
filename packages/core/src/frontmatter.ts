import YAML from "yaml";

export type Frontmatter = Record<string, unknown>;

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(text: string): { fm: Frontmatter; body: string; hasFm: boolean } {
  const m = FM_RE.exec(text);
  if (!m) return { fm: {}, body: text, hasFm: false };
  const fm = (YAML.parse(m[1]) ?? {}) as Frontmatter;
  return { fm, body: text.slice(m[0].length), hasFm: true };
}

export function stringifyNote(fm: Frontmatter, body: string): string {
  const yaml = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

/** Apply {{title}} / {{today}} placeholders in a template. */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}
