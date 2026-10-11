import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, type NoteDetail, type TypeDef } from "../api";
import Md from "../components/Md";
import { Err } from "../components/ui";
import { typeLabel } from "../App";

const READONLY = new Set(["type", "created", "updated", "sources", "related"]);

export default function Note() {
  const path = decodeURIComponent(useLocation().pathname.replace(/^\/note\//, ""));
  const [n, setN] = useState<NoteDetail | null>(null);
  const [def, setDef] = useState<TypeDef | null>(null);
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [line, setLine] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState("");
  const load = () => api.note(path).then(async (d) => { setN(d); setDef((await api.types()).find((t) => t.type === d.type) ?? null); }).catch(setErr);
  useEffect(() => { setN(null); setEdit(null); load(); }, [path]);
  if (err) return <Err e={err} />;
  if (!n) return <p className="muted">読み込み中…</p>;
  const fields = (def?.fields ?? Object.keys(n.fm)).filter((k) => !READONLY.has(k) && k !== "title" && k !== "summary" && k !== "tags" && k !== "status");
  const startEdit = () => setEdit(Object.fromEntries(["status", "summary", "tags", ...fields].map((k) => [k, toStr(n.fm[k])])));
  const save = async () => {
    if (!edit) return;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(edit)) {
      const orig = toStr(n.fm[k]);
      if (v === orig) continue;
      patch[k] = k === "tags" ? v.split(/[,\s]+/).filter(Boolean) : v === "" ? "" : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    try { await api.patch(path, { fm: patch }); setEdit(null); setSaved("保存しました"); load(); } catch (e) { setErr(e); }
  };
  const append = async () => {
    if (!line.trim()) return;
    try { await api.patch(path, { append: { section: n.type === "project" ? "現状" : "履歴", line } }); setLine(""); load(); } catch (e) { setErr(e); }
  };
  return (
    <>
      <p className="small muted"><Link to={`/notes/${n.type}`}>{typeLabel(n.type)}</Link> / {path}{n.archived && <span className="chip">archive</span>}</p>
      <h2>{n.title}</h2>
      {edit ? (
        <div className="fm">
          <label>status</label><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{(def?.statuses ?? [edit.status]).map((s) => <option key={s}>{s}</option>)}</select>
          <label>summary</label><input type="text" value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
          <label>tags</label><input type="text" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} placeholder="カンマ区切り" />
          {fields.map((k) => <FieldInput key={k} k={k} v={edit[k] ?? ""} onChange={(v) => setEdit({ ...edit, [k]: v })} />)}
          <span /><span><button onClick={save}>保存</button> <button className="ghost" onClick={() => setEdit(null)}>キャンセル</button></span>
        </div>
      ) : (
        <div className="fm">
          <label>status</label><span>{String(n.fm.status ?? "")}</span>
          <label>summary</label><span>{String(n.fm.summary ?? "")}</span>
          <label>tags</label><span>{(n.fm.tags as string[] | undefined)?.map((t) => <span key={t} className="chip">{t}</span>)}</span>
          {fields.filter((k) => n.fm[k] !== undefined && n.fm[k] !== "").map((k) => <FieldRow key={k} k={k} v={n.fm[k]} />)}
          <label>sources</label><span className="small muted">{(n.fm.sources as string[] | undefined)?.join(", ") || "—"}</span>
          <label>updated</label><span className="small muted">{String(n.fm.updated ?? "")} <button className="ghost small" onClick={startEdit} style={{ marginLeft: 12 }}>編集</button> <span className="ok small">{saved}</span></span>
        </div>
      )}
      <Md text={n.body} basePath={n.path} />
      {Object.entries(n.attachments).map(([name, text]) => <details key={name} open={name === "tasks.md"}><summary>{name}</summary><Md text={text} basePath={n.path} /></details>)}
      <div className="toolbar" style={{ marginTop: 20 }}>
        <input type="text" style={{ flex: 1, minWidth: 200 }} placeholder={n.type === "project" ? "現状に追記（日付付き）" : "履歴に追記（日付付き）"} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => e.key === "Enter" && append()} />
        <button className="ghost" onClick={append}>追記</button>
      </div>
      {(n.backlinks.length > 0 || n.links.length > 0) && (
        <p className="small muted">
          {n.links.length > 0 && <>リンク先: {n.links.map((l) => <Link key={l} to={`/note/${l}`}>{l.split("/").pop()}</Link>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}<br /></>}
          {n.backlinks.length > 0 && <>被リンク: {n.backlinks.map((l) => <Link key={l} to={`/note/${l}`}>{l.split("/").pop()}</Link>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}</>}
        </p>
      )}
    </>
  );
}
const toStr = (v: unknown) => Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v);
function FieldRow({ k, v }: { k: string; v: unknown }) {
  return <><label>{k}</label><span>{k === "rating" ? "★".repeat(Number(v)) : Array.isArray(v) ? v.join(", ") : String(v)}</span></>;
}
function FieldInput({ k, v, onChange }: { k: string; v: string; onChange: (v: string) => void }) {
  const isDate = /_at$|^due$|^start$|^next_renewal$|^review_due$|^last_reviewed$/.test(k);
  return <><label>{k}</label>{k === "rating" ? <select value={v} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{[1, 2, 3, 4, 5].map((r) => <option key={r} value={r}>{"★".repeat(r)}</option>)}</select> : <input type={isDate ? "date" : "text"} value={v} onChange={(e) => onChange(e.target.value)} />}</>;
}
