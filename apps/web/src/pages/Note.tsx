import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { PencilIcon } from "lucide-react";
import { api, type NoteDetail, type TypeDef } from "@/api";
import Md, { routeFor } from "@/components/Md";
import { Chip, Choice, Err, Loading, Toolbar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/lib/useAction";
import { typeLabel } from "../App";

const READONLY = new Set(["type", "created", "updated", "sources", "related"]);
const FM_GRID = "my-3 mb-5 grid max-w-[760px] grid-cols-[110px_1fr] items-start gap-x-3 gap-y-1.5 text-sm md:grid-cols-[140px_1fr]";

export default function Note() {
  const path = decodeURIComponent(useLocation().pathname.replace(/^\/note\//, ""));
  const [n, setN] = useState<NoteDetail | null>(null);
  const [def, setDef] = useState<TypeDef | null>(null);
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [line, setLine] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const show = (d: NoteDetail, types: TypeDef[]) => { setN(d); setDef(types.find((t) => t.type === d.type) ?? null); };
  const load = () => Promise.all([api.note(path), api.types()]).then(([d, types]) => show(d, types)).catch(setErr);
  useEffect(() => { setN(null); setEdit(null); setErr(null); load(); }, [path]);
  const save = useAction(async () => {
    if (!edit || !n) return;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(edit)) {
      const orig = toStr(n.fm[k]);
      if (v === orig) continue;
      patch[k] = k === "tags" ? v.split(/[,\s]+/).filter(Boolean) : v === "" ? "" : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    show(await api.patch(path, { fm: patch }), await api.types()); setEdit(null);
  }, { success: "保存しました" });
  const append = useAction(async () => {
    if (!n || !line.trim()) return;
    show(await api.patch(path, { append: { section: n.type === "project" ? "現状" : "履歴", line } }), await api.types()); setLine("");
  }, { success: "追記しました" });
  if (err && !n) return <Err e={err} />;
  if (!n) return <Loading rows={6} />;
  const fields = (def?.fields ?? Object.keys(n.fm)).filter((k) => !READONLY.has(k) && k !== "title" && k !== "summary" && k !== "tags" && k !== "status");
  const startEdit = () => setEdit(Object.fromEntries(["status", "summary", "tags", ...fields].map((k) => [k, toStr(n.fm[k])])));
  const appendLabel = n.type === "project" ? "現状に追記（日付付き）" : "履歴に追記（日付付き）";
  return (
    <>
      <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground"><Link to={`/notes/${n.type}`}>{typeLabel(n.type)}</Link> / {path}{n.archived && <Chip>archive</Chip>}</p>
      <h2 className="mt-1 mb-2 text-2xl font-semibold tracking-tight">{n.title}</h2>
      <Err e={err} />
      {edit ? (
        <form className={FM_GRID} onSubmit={(e) => { e.preventDefault(); save.run(); }}>
          <fieldset disabled={save.pending} className="contents">
            <Label className="pt-2 text-muted-foreground">status</Label>
            <Choice className="w-fit" value={edit.status} onChange={(v) => setEdit({ ...edit, status: v })} options={def?.statuses ?? [edit.status]} disabled={save.pending} />
            <Label htmlFor="f-summary" className="pt-2 text-muted-foreground">summary</Label>
            <Input id="f-summary" value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
            <Label htmlFor="f-tags" className="pt-2 text-muted-foreground">tags</Label>
            <Input id="f-tags" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} placeholder="カンマ区切り" />
            {fields.map((k) => <FieldInput key={k} k={k} v={edit[k] ?? ""} disabled={save.pending} onChange={(v) => setEdit({ ...edit, [k]: v })} />)}
            <span />
            <span className="flex gap-2 pt-1">
              <Button type="submit" loading={save.pending}>保存</Button>
              <Button type="button" variant="outline" onClick={() => setEdit(null)}>キャンセル</Button>
            </span>
          </fieldset>
        </form>
      ) : (
        <div className={FM_GRID}>
          <Label className="text-muted-foreground">status</Label><span>{String(n.fm.status ?? "")}</span>
          <Label className="text-muted-foreground">summary</Label><span>{String(n.fm.summary ?? "")}</span>
          <Label className="text-muted-foreground">tags</Label><span className="flex flex-wrap gap-1">{(n.fm.tags as string[] | undefined)?.map((t) => <Chip key={t}>{t}</Chip>)}</span>
          {fields.filter((k) => n.fm[k] !== undefined && n.fm[k] !== "").map((k) => <FieldRow key={k} k={k} v={n.fm[k]} />)}
          <Label className="text-muted-foreground">sources</Label><span className="text-muted-foreground">{(n.fm.sources as string[] | undefined)?.join(", ") || "—"}</span>
          <Label className="text-muted-foreground">updated</Label>
          <span className="flex items-center gap-3 text-muted-foreground">{String(n.fm.updated ?? "")} <Button variant="outline" size="sm" onClick={startEdit}><PencilIcon data-icon="inline-start" />編集</Button></span>
        </div>
      )}
      <Md text={n.body} basePath={n.path} />
      {Object.entries(n.attachments).map(([name, text]) => <details key={name} open={name === "tasks.md"} className="my-3"><summary className="cursor-pointer font-medium">{name}</summary><Md text={text} basePath={n.path} /></details>)}
      <form className="mt-5" onSubmit={(e) => { e.preventDefault(); append.run(); }}>
        <Toolbar>
          <Input className="min-w-52 flex-1" placeholder={appendLabel} aria-label={appendLabel} value={line} onChange={(e) => setLine(e.target.value)} disabled={append.pending} />
          <Button type="submit" variant="outline" loading={append.pending} disabled={!line.trim()}>追記</Button>
        </Toolbar>
      </form>
      {(n.backlinks.length > 0 || n.links.length > 0) && (
        <p className="text-sm text-muted-foreground">
          {n.links.length > 0 && <>リンク先: {n.links.map((l) => <Link key={l} to={routeFor(l)}>{l.split("/").pop()}</Link>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}<br /></>}
          {n.backlinks.length > 0 && <>被リンク: {n.backlinks.map((l) => <Link key={l} to={routeFor(l)}>{l.split("/").pop()}</Link>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}</>}
        </p>
      )}
    </>
  );
}
const toStr = (v: unknown) => Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v);
function FieldRow({ k, v }: { k: string; v: unknown }) {
  return <><Label className="text-muted-foreground">{k}</Label><span>{k === "rating" ? "★".repeat(Number(v)) : Array.isArray(v) ? v.join(", ") : String(v)}</span></>;
}
function FieldInput({ k, v, onChange, disabled }: { k: string; v: string; onChange: (v: string) => void; disabled?: boolean }) {
  const isDate = /_at$|^due$|^start$|^next_renewal$|^review_due$|^last_reviewed$/.test(k);
  const id = `f-${k}`;
  return <>
    <Label htmlFor={id} className="pt-2 text-muted-foreground">{k}</Label>
    {k === "rating"
      ? <Choice id={id} className="w-fit" value={v} onChange={onChange} disabled={disabled} options={[{ value: "", label: "—" }, ...[1, 2, 3, 4, 5].map((r) => ({ value: String(r), label: "★".repeat(r) }))]} />
      : <Input id={id} className={isDate ? "w-fit" : undefined} type={isDate ? "date" : "text"} value={v} onChange={(e) => onChange(e.target.value)} />}
  </>;
}
