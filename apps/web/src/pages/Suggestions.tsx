import { useEffect, useState } from "react";
import { api } from "../api";
import { Err } from "../components/ui";

interface Item { id: string; section: string; line: string; title: string; reacted?: string; url?: string }

/** Parses 30_gold/37_suggestions.md: "- [ ] **Title** — ... <!-- id: x[, reaction: y] -->" under "## 本" / "## 映画・ドラマ" / "## 記事". */
function parse(md: string): { updated: string; items: Item[] } {
  const items: Item[] = []; let section = "";
  const updated = /（(\d{4}-\d{2}-\d{2}) 更新）/.exec(md)?.[1] ?? "";
  for (const line of md.split("\n")) {
    const h = /^##\s+(.+)/.exec(line); if (h) { section = h[1].trim(); continue; }
    const m = /^- \[[ x]\]\s*(.*?)\s*<!--\s*id:\s*([^,\s]+)(?:,\s*reaction:\s*(\w+))?\s*-->/.exec(line);
    if (!m) continue;
    const body = m[1];
    const title = /\*\*(.+?)\*\*/.exec(body)?.[1] ?? /\[(.+?)\]\(/.exec(body)?.[1] ?? body;
    const url = /\((https?:[^)]+)\)/.exec(body)?.[1];
    items.push({ id: m[2], section, line: body.replace(/\*\*/g, ""), title, reacted: m[3], url });
  }
  return { updated, items };
}

export default function Suggestions() {
  const [data, setData] = useState<{ updated: string; items: Item[] } | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const load = () => api.gold("37_suggestions").then((g) => setData(parse(g.markdown))).catch(setErr);
  useEffect(() => { load(); }, []);
  const react = async (it: Item, reaction: "read" | "dismissed") => {
    const type = it.section.includes("本") ? "book" : it.section.includes("映画") ? "media" : undefined;
    try { await api.react({ id: it.id, reaction, title: it.title, type: type as "book" | "media" | undefined }); load(); } catch (e) { setErr(e); }
  };
  const refresh = async () => { setBusy(true); try { await api.runJob("recommend"); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (err) return <Err e={err} />;
  if (!data) return <p className="muted">読み込み中…</p>;
  const sections = [...new Set(data.items.map((i) => i.section))];
  return (
    <>
      <h2>おすすめ <span className="muted small">{data.updated && `${data.updated} 更新`}</span></h2>
      <div className="toolbar"><button className="ghost" disabled={busy} onClick={refresh}>recommend を実行（Mac ワーカー）</button></div>
      {data.items.length === 0 && <p className="muted">まだ提案がありません。上のボタンで生成できます。</p>}
      {sections.map((s) => (
        <section key={s}><h3>{s}</h3>
          <ul>{data.items.filter((i) => i.section === s).map((it) => (
            <li key={it.id} style={{ opacity: it.reacted ? 0.5 : 1 }}>
              {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : <b>{it.title}</b>} <span className="small muted">{it.line.replace(it.title, "").replace(/^\s*[—-]\s*/, "")}</span>
              {it.reacted ? <span className="chip">{it.reacted}</span> : <span style={{ marginLeft: 8 }}><button className="ghost small" onClick={() => react(it, "read")}>{s.includes("記事") ? "読んだ" : "読む/観る"}</button> <button className="ghost small" onClick={() => react(it, "dismissed")}>興味なし</button></span>}
            </li>))}</ul>
        </section>))}
    </>
  );
}
