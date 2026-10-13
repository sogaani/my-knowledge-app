import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PlusIcon, SearchIcon } from "lucide-react";
import { api, type NoteSummary, type SearchResponse, type TypeDef } from "@/api";
import { Chip, Choice, Err, NoteLink, PageTitle, Stars, Status, Toolbar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAction } from "@/lib/useAction";
import { formatMoney } from "@/lib/utils";
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
  const navigate = useNavigate();
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [newTitle, setNewTitle] = useState("");
  const text = sp.get("q") ?? "", status = sp.get("status") ?? "", archive = sp.get("archive") ?? "";
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const mode: Mode = sp.get("mode") === "keyword" ? "keyword" : "hybrid";
  // Semantic search goes through the Mac worker (LanceDB + Ollama); plain listing/keyword stays on the API's SQLite.
  const semantic = !!text && mode === "hybrid";
  const def = types.find((t) => t.type === type);
  const seq = useRef(0);
  const load = () => {
    const my = ++seq.current;
    const current = () => my === seq.current; // a newer query was started: drop this answer
    setErr(null); setBusy(true);
    const common = { ...(type ? { type } : {}), ...(status ? { status } : {}), ...(archive ? { archive } : {}) };
    let p: Promise<unknown>;
    if (semantic) {
      // The worker round trip takes ~1s: show the API's own keyword hits first, then replace them with the hybrid ones.
      let final = false;
      api.search({ ...common, q: text, mode: "keyword", limit: "30" }).then((r) => { if (current() && !final) setRes(r); }).catch(() => {});
      p = api.search({ ...common, q: text, mode, limit: "30" }).then((r) => { final = true; if (current()) setRes(r); });
    } else {
      p = api.notes({ ...common, ...(text ? { text } : {}), limit: "500" }).then((r) => { if (current()) { setRes(null); setRows(r); } });
    }
    p.catch((e) => current() && setErr(e)).finally(() => current() && setBusy(false));
  };
  useEffect(() => { api.types().then(setTypes).catch(setErr); }, []);
  useEffect(() => { load(); }, [type, text, status, archive, mode]);
  const cols = useMemo(() => COLUMNS[type ?? ""] ?? [], [type]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n); };
  const create = useAction(async () => {
    if (!type || !newTitle.trim()) return;
    const r = await api.create({ type, title: newTitle.trim() }); setNewTitle(""); navigate(`/note/${r.path}`);
  }, { success: "作成しました" });
  const count = semantic ? res?.hits.length ?? 0 : rows.length;
  return (
    <>
      <PageTitle sub={busy ? <><Spinner />検索中…</> : `${count} 件`}>{type ? typeLabel(type) : "検索"}</PageTitle>
      <Toolbar>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); set("q", draft.trim()); }}>
          <Input type="search" className="w-64" placeholder={mode === "keyword" ? "本文・タイトル検索" : "意味で検索（例: 孤島が舞台のミステリー）"} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" variant="outline" size="icon" aria-label="検索" loading={busy && !!text}>{!(busy && text) && <SearchIcon />}</Button>
        </form>
        <span title="意味検索は Mac のワーカー経由。応答がなければキーワード検索に切り替わる">
          <Choice value={mode === "keyword" ? "keyword" : ""} onChange={(v) => set("mode", v)} options={[{ value: "", label: "意味 + キーワード" }, { value: "keyword", label: "キーワードのみ" }]} />
        </span>
        {def && <Choice value={status} onChange={(v) => set("status", v)} options={[{ value: "", label: "status: all" }, ...def.statuses]} />}
        <Label className="font-normal"><Checkbox checked={archive === "1"} onCheckedChange={(c) => set("archive", c === true ? "1" : "")} /> アーカイブも</Label>
        {type && (
          <form className="flex gap-2 md:ml-auto" onSubmit={(e) => { e.preventDefault(); create.run(); }}>
            <Input className="w-56" placeholder={`新規 ${typeLabel(type)} のタイトル`} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} disabled={create.pending} />
            <Button type="submit" variant="outline" loading={create.pending} disabled={!newTitle.trim()}>{!create.pending && <PlusIcon data-icon="inline-start" />}作成</Button>
          </form>
        )}
      </Toolbar>
      <Err e={err} />
      {semantic && res && (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {MODE_LABEL[res.mode] ?? res.mode}
            {res.degraded && <> — <span className="text-destructive">キーワード検索に切り替えました（{res.degraded}）</span></>}
          </p>
          <div className="space-y-2.5">
            {res.hits.map((h) => (
              <Card key={h.path} className={h.confidence === "low" ? "gap-1 py-3 opacity-70" : "gap-1 py-3"}>
                <CardContent className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <NoteLink n={h} /> <Chip>{typeLabel(h.type)}</Chip> <Status s={h.status} />
                    {h.archived && <Chip>archive</Chip>}
                    {h.confidence === "low" && <span title="意味が近いだけ（語の一致や強い類似はない）"><Chip className="text-muted-foreground">弱い一致</Chip></span>}
                    <span className="ml-auto text-sm text-muted-foreground">{h.updated}</span>
                  </div>
                  {h.summary && <div className="text-sm text-muted-foreground">{h.summary}</div>}
                  {h.matches.map((m, i) => (
                    <div className="text-sm" key={i}>
                      <Chip className="mr-1">{m.via.map((v) => (v === "vector" ? "意味" : "語")).join("+")}</Chip>
                      {m.heading && <b>{m.heading}: </b>}
                      <span className={m.spoiler ? "text-muted-foreground" : ""}>{m.snippet}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
          {!busy && !res.hits.length && <p className="text-muted-foreground">該当なし</p>}
        </>
      )}
      {!semantic && (
        <Table className={busy ? "opacity-60 transition-opacity" : undefined}>
          <TableHeader><TableRow><TableHead>タイトル</TableHead>{!type && <TableHead>type</TableHead>}<TableHead>状態</TableHead>{cols.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}<TableHead>要約</TableHead><TableHead>更新</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((n) => (
            <TableRow key={n.path}>
              <TableCell className="whitespace-normal"><NoteLink n={n} />{n.archived && <Chip className="ml-1">archive</Chip>}</TableCell>
              {!type && <TableCell><Chip>{typeLabel(n.type)}</Chip></TableCell>}
              <TableCell><Status s={n.status} /></TableCell>
              {cols.map((c) => <TableCell key={c.key}>{c.key === "rating" ? <Stars n={n.fm[c.key]} /> : c.key === "price" ? fmtPrice(n.fm) : String(n.fm[c.key] ?? "")}</TableCell>)}
              <TableCell className="min-w-48 whitespace-normal text-muted-foreground">{n.summary}</TableCell><TableCell className="text-muted-foreground">{n.updated}</TableCell>
            </TableRow>))}</TableBody>
        </Table>
      )}
    </>
  );
}
const fmtPrice = (fm: Record<string, unknown>) => (fm.price ? formatMoney(Number(fm.price), String(fm.currency ?? "").trim().toUpperCase() || "JPY") : "");
