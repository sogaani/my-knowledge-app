import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PlusIcon, SearchIcon } from "lucide-react";
import { api, type NoteSummary, type SearchResponse, type TypeDef } from "@/api";
import { Chip, Choice, Err, Hl, NoteLink, PageTitle, Stars, Status, Toolbar, fmtViewed } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { queryTerms } from "@/lib/terms";
import { useAction } from "@/lib/useAction";
import { cn, formatMoney } from "@/lib/utils";
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
/** Search hits come in pages of PAGE; "もっと見る" asks the API for the next page size up to its cap (100). */
const PAGE = 30, MAX_LIMIT = 100;

/** Distinct values of `key` with their counts, most frequent first. */
function tally<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
/** One facet row: toggle chips, the selected one highlighted. Hidden when there is only one value to choose from. */
function Facet({ label, counts, value, onChange, render }: { label: string; counts: [string, number][]; value: string; onChange: (v: string) => void; render?: (v: string) => string }) {
  if (counts.length < 2 && !value) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      <span className="mr-1 text-muted-foreground">{label}:</span>
      {counts.map(([v, n]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(value === v ? "" : v)}
          className={cn("rounded-4xl border px-2 py-0.5 text-xs transition-colors hover:bg-muted", value === v ? "border-foreground bg-foreground text-background hover:bg-foreground/90" : "border-border")}>
          {render ? render(v) : v} <span className={value === v ? "opacity-70" : "text-muted-foreground"}>{n}</span>
        </button>
      ))}
    </div>
  );
}

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
  // page size and facets belong to one query (`key`): a new query starts again at PAGE with nothing selected
  const key = JSON.stringify([type, text, status, archive, mode]);
  const [page, setPage] = useState({ key: "", limit: PAGE });
  const limit = page.key === key ? page.limit : PAGE;
  // client-side facets over the result set (search page only; a type page filters status on the server)
  const [picked, setPicked] = useState({ key: "", type: "", status: "" });
  const facet = picked.key === key ? picked : { type: "", status: "" };
  const setFacet = (f: { type: string; status: string }) => setPicked({ key, ...f });
  const terms = useMemo(() => queryTerms(text), [text]);
  // Semantic search goes through the Mac worker (LanceDB + Ollama); plain listing/keyword stays on the API's SQLite.
  const semantic = !!text && mode === "hybrid";
  const def = types.find((t) => t.type === type);
  const seq = useRef(0);
  const lastKey = useRef("");
  const load = () => {
    const my = ++seq.current;
    const current = () => my === seq.current; // a newer query was started: drop this answer
    const more = key === lastKey.current && res !== null; // same query, bigger page: keep the list as is while the next page loads
    lastKey.current = key;
    setErr(null); setBusy(true);
    const common = { ...(type ? { type } : {}), ...(status ? { status } : {}), ...(archive ? { archive } : {}) };
    let p: Promise<unknown>;
    if (semantic) {
      // The worker round trip takes ~1s: show the API's own keyword hits first, then replace them with the hybrid ones.
      let final = false;
      if (!more) api.search({ ...common, q: text, mode: "keyword", limit: String(limit) }).then((r) => { if (current() && !final) setRes(r); }).catch(() => {});
      p = api.search({ ...common, q: text, mode, limit: String(limit) }).then((r) => { final = true; if (current()) setRes(r); });
    } else {
      p = api.notes({ ...common, ...(text ? { text } : {}), limit: "500" }).then((r) => { if (current()) { setRes(null); setRows(r); } });
    }
    p.catch((e) => current() && setErr(e)).finally(() => current() && setBusy(false));
  };
  useEffect(() => { api.types().then(setTypes).catch(setErr); }, []);
  useEffect(() => { load(); }, [key, limit]);
  const cols = useMemo(() => COLUMNS[type ?? ""] ?? [], [type]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n); };
  const create = useAction(async () => {
    if (!type || !newTitle.trim()) return;
    const r = await api.create({ type, title: newTitle.trim() }); setNewTitle(""); navigate(`/note/${r.path}`);
  }, { success: "作成しました" });
  // facets: tallied over everything the query returned, applied on the client
  const all: { type: string; status: string }[] = semantic ? res?.hits ?? [] : rows;
  const typeCounts = type ? [] : tally(all, (x) => x.type);
  const statusCounts = type ? [] : tally(all, (x) => x.status);
  const keep = (x: { type: string; status: string }) => (!facet.type || x.type === facet.type) && (!facet.status || x.status === facet.status);
  const hits = (res?.hits ?? []).filter(keep), shown = rows.filter(keep);
  const count = semantic ? hits.length : shown.length;
  const total = all.length;
  const canMore = semantic && !!res && !res.degraded && res.hits.length >= limit && limit < MAX_LIMIT;
  return (
    <>
      <PageTitle sub={busy ? <><Spinner />検索中…</> : `${count} 件${count !== total ? ` / ${total}` : ""}`}>{type ? typeLabel(type) : "検索"}</PageTitle>
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
      {!type && (typeCounts.length > 1 || statusCounts.length > 1 || facet.type || facet.status) && (
        <div className="mb-3 space-y-1">
          <Facet label="type" counts={typeCounts} value={facet.type} onChange={(v) => setFacet({ ...facet, type: v })} render={typeLabel} />
          <Facet label="status" counts={statusCounts} value={facet.status} onChange={(v) => setFacet({ ...facet, status: v })} />
        </div>
      )}
      {semantic && res && (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {MODE_LABEL[res.mode] ?? res.mode}
            {res.degraded && <> — <span className="text-destructive">キーワード検索に切り替えました（{res.degraded}）</span></>}
          </p>
          <div className="space-y-2.5">
            {hits.map((h) => (
              <Card key={h.path} className={h.confidence === "low" ? "gap-1 py-3 opacity-70" : "gap-1 py-3"}>
                <CardContent className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <NoteLink n={h}><Hl text={h.title} terms={terms} /></NoteLink> <Chip>{typeLabel(h.type)}</Chip> <Status s={h.status} />
                    {h.archived && <Chip>archive</Chip>}
                    {h.confidence === "low" && <span title="意味が近いだけ（語の一致や強い類似はない）"><Chip className="text-muted-foreground">弱い一致</Chip></span>}
                    <span className="ml-auto text-sm text-muted-foreground">{h.updated}</span>
                  </div>
                  {h.summary && <div className="text-sm text-muted-foreground"><Hl text={h.summary} terms={terms} /></div>}
                  {h.matches.map((m, i) => (
                    <div className="text-sm" key={i}>
                      <Chip className="mr-1">{m.via.map((v) => (v === "vector" ? "意味" : "語")).join("+")}</Chip>
                      {m.heading && <b><Hl text={m.heading} terms={terms} />: </b>}
                      <span className={m.spoiler ? "text-muted-foreground" : ""}><Hl text={m.snippet} terms={terms} /></span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
          {!busy && !hits.length && <p className="text-muted-foreground">該当なし</p>}
          {canMore && (
            <div className="mt-3"><Button variant="outline" loading={busy} onClick={() => setPage({ key, limit: Math.min(limit + PAGE, MAX_LIMIT) })}>もっと見る（{res.hits.length} 件まで表示中）</Button></div>
          )}
        </>
      )}
      {!semantic && (
        <Table className={busy ? "opacity-60 transition-opacity" : undefined}>
          <TableHeader><TableRow><TableHead>タイトル</TableHead>{!type && <TableHead>type</TableHead>}<TableHead>状態</TableHead>{cols.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}<TableHead>要約</TableHead><TableHead>更新</TableHead><TableHead>閲覧</TableHead></TableRow></TableHeader>
          <TableBody>{shown.map((n) => (
            <TableRow key={n.path}>
              <TableCell className="whitespace-normal"><NoteLink n={n}><Hl text={n.title} terms={terms} /></NoteLink>{n.archived && <Chip className="ml-1">archive</Chip>}</TableCell>
              {!type && <TableCell><Chip>{typeLabel(n.type)}</Chip></TableCell>}
              <TableCell><Status s={n.status} /></TableCell>
              {cols.map((c) => <TableCell key={c.key}>{c.key === "rating" ? <Stars n={n.fm[c.key]} /> : c.key === "price" ? fmtPrice(n.fm) : String(n.fm[c.key] ?? "")}</TableCell>)}
              <TableCell className="min-w-48 whitespace-normal text-muted-foreground"><Hl text={n.summary} terms={terms} /></TableCell><TableCell className="text-muted-foreground">{n.updated}</TableCell><TableCell className="text-muted-foreground" title={n.viewed ?? undefined}>{fmtViewed(n.viewed)}</TableCell>
            </TableRow>))}</TableBody>
        </Table>
      )}
    </>
  );
}
const fmtPrice = (fm: Record<string, unknown>) => (fm.price ? formatMoney(Number(fm.price), String(fm.currency ?? "").trim().toUpperCase() || "JPY") : "");
