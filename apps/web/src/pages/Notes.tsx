import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type NoteSummary, type SearchResponse, type TypeDef } from "../api";
import { Err, NoteLink, Stars, Status } from "../components/ui";
import { typeLabel } from "../App";

const COLUMNS: Record<string, { key: string; label: string }[]> = {
  book: [{ key: "author", label: "著者" }, { key: "genre", label: "ジャンル" }, { key: "subgenre", label: "サブ" }, { key: "rating", label: "評価" }, { key: "finished_at", label: "読了" }],
  media: [{ key: "kind", label: "種別" }, { key: "platform", label: "配信" }, { key: "rating", label: "評価" }, { key: "watched_at", label: "視聴" }],
  subscription: [{ key: "plan", label: "プラン" }, { key: "price", label: "料金" }, { key: "cycle", label: "周期" }, { key: "next_renewal", label: "次回更新" }],
  finance_account: [{ key: "kind", label: "種別" }, { key: "purpose", label: "用途" }, { key: "tax_scheme", label: "制度" }, { key: "review_due", label: "見直し" }],
  project: [{ key: "area", label: "領域" }, { key: "due", label: "期限" }],
  learning: [{ key: "topic", label: "トピック" }, { key: "level", label: "レベル" }, { key: "last_reviewed", label: "復習" }],
  review: [{ key: "period", label: "周期" }, { key: "range", label: "範囲" }],
  person: [{ key: "role", label: "役割" }],
};
type Mode = "hybrid" | "keyword";
const MODE_LABEL: Record<string, string> = { hybrid: "意味 + キーワード", vector: "意味検索", keyword: "キーワード" };

export default function Notes() {
  const { type } = useParams();
  const [sp, setSp] = useSearchParams();
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [newTitle, setNewTitle] = useState("");
  const text = sp.get("q") ?? "", status = sp.get("status") ?? "", archive = sp.get("archive") ?? "";
  const mode: Mode = sp.get("mode") === "keyword" ? "keyword" : "hybrid";
  // Semantic search goes through the Mac worker (LanceDB + Ollama); plain listing/keyword stays on the API's SQLite.
  const semantic = !!text && mode === "hybrid";
  const def = types.find((t) => t.type === type);
  const load = () => {
    setErr(null);
    const common = { ...(type ? { type } : {}), ...(status ? { status } : {}), ...(archive ? { archive } : {}) };
    if (semantic) {
      setBusy(true);
      api.search({ ...common, q: text, mode, limit: "30" }).then(setRes).catch(setErr).finally(() => setBusy(false));
    } else {
      setRes(null);
      api.notes({ ...common, ...(text ? { text } : {}), limit: "500" }).then(setRows).catch(setErr);
    }
  };
  useEffect(() => { api.types().then(setTypes).catch(setErr); }, []);
  useEffect(() => { load(); }, [type, text, status, archive, mode]);
  const cols = useMemo(() => COLUMNS[type ?? ""] ?? [], [type]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n); };
  const create = async () => {
    if (!type || !newTitle.trim()) return;
    try { const r = await api.create({ type, title: newTitle.trim() }); setNewTitle(""); location.assign(`/note/${r.path}`); } catch (e) { setErr(e); }
  };
  const count = semantic ? res?.hits.length ?? 0 : rows.length;
  return (
    <>
      <h2>{type ? typeLabel(type) : "検索"} <span className="muted small">{busy ? "検索中…" : `${count} 件`}</span></h2>
      <div className="toolbar">
        <input type="search" placeholder={mode === "keyword" ? "本文・タイトル検索" : "意味で検索（例: 孤島が舞台のミステリー）"} defaultValue={text} onKeyDown={(e) => e.key === "Enter" && set("q", (e.target as HTMLInputElement).value)} />
        <select value={mode} onChange={(e) => set("mode", e.target.value === "keyword" ? "keyword" : "")} title="意味検索は Mac のワーカー経由。応答がなければキーワード検索に切り替わる">
          <option value="hybrid">意味 + キーワード</option>
          <option value="keyword">キーワードのみ</option>
        </select>
        {def && <select value={status} onChange={(e) => set("status", e.target.value)}><option value="">status: all</option>{def.statuses.map((s) => <option key={s}>{s}</option>)}</select>}
        <label className="small"><input type="checkbox" checked={archive === "1"} onChange={(e) => set("archive", e.target.checked ? "1" : "")} /> アーカイブも</label>
        {type && <span style={{ marginLeft: "auto" }}><input type="text" placeholder={`新規 ${typeLabel(type)} のタイトル`} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} /> <button className="ghost" onClick={create}>作成</button></span>}
      </div>
      <Err e={err} />
      {semantic && res && (
        <>
          <p className="small muted">
            {MODE_LABEL[res.mode] ?? res.mode}
            {res.degraded && <> — <span className="err">キーワード検索に切り替えました（{res.degraded}）</span></>}
          </p>
          {res.hits.map((h) => (
            <div className="card" key={h.path} style={{ marginBottom: 10 }}>
              <div>
                <NoteLink n={h} /> <span className="chip">{typeLabel(h.type)}</span> <Status s={h.status} />
                {h.archived && <span className="chip">archive</span>}
                <span className="muted small" style={{ float: "right" }}>{h.score ? h.score.toFixed(3) : ""} · {h.updated}</span>
              </div>
              {h.summary && <div className="small muted">{h.summary}</div>}
              {h.matches.map((m, i) => (
                <div className="small" key={i} style={{ marginTop: 4 }}>
                  <span className="chip">{m.via.map((v) => (v === "vector" ? "意味" : "語")).join("+")}</span>
                  {m.heading && <b>{m.heading}: </b>}
                  <span className={m.spoiler ? "muted" : ""}>{m.snippet}</span>
                </div>
              ))}
            </div>
          ))}
          {!busy && !res.hits.length && <p className="muted">該当なし</p>}
        </>
      )}
      {!semantic && (
        <div className="tablewrap"><table>
          <thead><tr><th>タイトル</th>{!type && <th>type</th>}<th>状態</th>{cols.map((c) => <th key={c.key}>{c.label}</th>)}<th>要約</th><th>更新</th></tr></thead>
          <tbody>{rows.map((n) => (
            <tr key={n.path}>
              <td><NoteLink n={n} />{n.archived && <span className="chip">archive</span>}</td>
              {!type && <td><span className="chip">{typeLabel(n.type)}</span></td>}
              <td><Status s={n.status} /></td>
              {cols.map((c) => <td key={c.key}>{c.key === "rating" ? <Stars n={n.fm[c.key]} /> : c.key === "price" ? fmtPrice(n.fm) : String(n.fm[c.key] ?? "")}</td>)}
              <td className="small muted">{n.summary}</td><td className="small muted">{n.updated}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}
const fmtPrice = (fm: Record<string, unknown>) => fm.price ? `¥${Number(fm.price).toLocaleString()}` : "";
