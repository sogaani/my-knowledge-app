import { useEffect, useState } from "react";
import { CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { api } from "@/api";
import { Chip, Err, Loading, NoteLink, PageTitle, Section, Toolbar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

interface Item { id: string; section: string; line: string; title: string; reacted?: string; url?: string }
interface Data { path: string | null; title?: string; updated: string; items: Item[] }

/**
 * Parses the current `recommendation` note (200_silver/208_reviews): "- [ ] **Title** — ... <!-- id: x[, reaction: y] -->"
 * under "## 本" / "## 映画・ドラマ" / "## 記事". Same grammar as `parseSuggestions` in @kb/core (the API records reactions there).
 */
function parse(md: string): Item[] {
  const items: Item[] = []; let section = "";
  for (const line of md.split("\n")) {
    const h = /^##\s+(.+)/.exec(line); if (h) { section = h[1].trim(); continue; }
    const m = /^- \[[ x]\]\s*(.*?)\s*<!--\s*id:\s*([^,\s]+)(?:,\s*reaction:\s*(\w+))?\s*-->/.exec(line);
    if (!m) continue;
    const body = m[1];
    const title = /\*\*(.+?)\*\*/.exec(body)?.[1] ?? /\[(.+?)\]\(/.exec(body)?.[1] ?? body;
    const url = /\((https?:[^)]+)\)/.exec(body)?.[1];
    items.push({ id: m[2], section, line: body.replace(/\*\*/g, ""), title, reacted: m[3], url });
  }
  return items;
}

export default function Suggestions() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => api.suggestions().then((s) => setData({ path: s.path, title: s.title, updated: s.updated, items: parse(s.markdown) })).catch(setErr);
  useEffect(() => { load(); }, []);
  const refresh = useAction(() => api.runJob("recommend"), { success: (j) => `recommend を投入しました（${j.id.slice(0, 8)}）。終わったら再読み込みしてください` });
  if (err) return <Err e={err} />;
  if (!data) return <><PageTitle>おすすめ</PageTitle><Loading /></>;
  const sections = [...new Set(data.items.map((i) => i.section))];
  return (
    <>
      <PageTitle sub={data.updated && `${data.updated} 更新`}>おすすめ</PageTitle>
      <Toolbar>
        <Button variant="outline" loading={refresh.pending} onClick={() => refresh.run()}>{!refresh.pending && <SparklesIcon data-icon="inline-start" />}recommend を実行（Mac ワーカー）</Button>
        {data.path && <span className="text-sm text-muted-foreground">ノート: <NoteLink n={{ path: data.path, title: data.title ?? data.path }} /></span>}
      </Toolbar>
      {data.items.length === 0 && <p className="text-muted-foreground">まだ提案がありません。上のボタンで生成できます。</p>}
      {sections.map((s) => (
        <section key={s}><Section>{s}</Section>
          <ul className="space-y-2">{data.items.filter((i) => i.section === s).map((it) => <SuggestionItem key={it.id} it={it} article={s.includes("記事")} onDone={load} />)}</ul>
        </section>))}
    </>
  );
}

/** One row: its own pending state, so the clicked button spins and both buttons lock until the reaction is saved. */
function SuggestionItem({ it, article, onDone }: { it: Item; article: boolean; onDone: () => Promise<unknown> }) {
  const [which, setWhich] = useState<"read" | "dismissed" | null>(null);
  const react = useAction(async (reaction: "read" | "dismissed") => {
    setWhich(reaction);
    const r = await api.react({ id: it.id, reaction });
    await onDone();
    return r;
  }, { success: (r) => (r.created ? `ノートを作成しました: ${r.created}` : r.existing ? `記録しました（既存のノート: ${r.existing}）` : "記録しました") });
  return (
    <li className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", it.reacted && "opacity-50")}>
      <span className="min-w-0 flex-1">
        {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : <b>{it.title}</b>} <span className="text-sm text-muted-foreground">{it.line.replace(it.title, "").replace(/^\s*[—-]\s*/, "")}</span>
      </span>
      {it.reacted ? <Chip>{it.reacted}</Chip> : (
        <span className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={react.pending} loading={react.pending && which === "read"} onClick={() => react.run("read")}>{!(react.pending && which === "read") && <CheckIcon data-icon="inline-start" />}{article ? "読んだ" : "読む/観る"}</Button>
          <Button size="sm" variant="ghost" disabled={react.pending} loading={react.pending && which === "dismissed"} onClick={() => react.run("dismissed")}>{!(react.pending && which === "dismissed") && <XIcon data-icon="inline-start" />}興味なし</Button>
        </span>
      )}
    </li>
  );
}
