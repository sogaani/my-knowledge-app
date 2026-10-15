import { useEffect, useState } from "react";
import { InboxIcon, XIcon } from "lucide-react";
import { api, type ArticleDay, type ArticleItem, type ArticleReaction } from "@/api";
import { Chip, Err, Loading, PageTitle, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

/** Older days are fetched this many at a time, and only once the 過去の記事 section is opened. */
const PAGE = 7;

/**
 * The day's RSS picks (900_system/articles/<date>.json, written by the curate job every morning). Only the latest day
 * loads; the rest of that day's candidates and the earlier days sit behind <details> and load on demand. Opening a
 * link records `opened` (that is what teaches the next run), the buttons record `saved` (→ ingest) / `dismissed`.
 */
export default function Articles() {
  const [latest, setLatest] = useState<ArticleDay | null | undefined>(undefined);
  const [err, setErr] = useState<unknown>(null);
  const [history, setHistory] = useState<{ items: ArticleDay[]; next: string | null } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  useEffect(() => { api.articles({ limit: 1 }).then((r) => setLatest(r.items[0] ?? null)).catch(setErr); }, []);
  const refresh = useAction(() => api.runJob("curate"), { success: (j) => `curate を投入しました（${j.id.slice(0, 8)}）。終わったら再読み込みしてください` });

  const loadHistory = async (before: string | undefined) => {
    setHistoryBusy(true);
    try {
      const r = await api.articles({ limit: PAGE, before });
      setHistory((h) => ({ items: before && h ? [...h.items, ...r.items] : r.items, next: r.next }));
    } catch (e) { setErr(e); } finally { setHistoryBusy(false); }
  };
  const onToggleHistory = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && history === null && !historyBusy) loadHistory(latest?.date);
  };
  // A reaction updates the item in whichever day holds it (the latest day or one in the history).
  const patch = (date: string, item: ArticleItem) => {
    const upd = (d: ArticleDay) => (d.date === date ? { ...d, items: d.items.map((i) => (i.id === item.id ? item : i)) } : d);
    setLatest((d) => (d ? upd(d) : d));
    setHistory((h) => (h ? { ...h, items: h.items.map(upd) } : h));
  };

  if (err) return <Err e={err} />;
  if (latest === undefined) return <><PageTitle>記事</PageTitle><Loading /></>;
  return (
    <>
      <PageTitle sub="RSS の新着から毎朝選んだ記事。開いた・取り込んだ・興味なしが次の選別に効きます">記事</PageTitle>
      <div className="mb-2">
        <Button variant="outline" size="sm" loading={refresh.pending} onClick={() => refresh.run()}>curate を実行（Mac ワーカー）</Button>
      </div>
      {latest ? <Day day={latest} onPatch={patch} open /> : <p className="text-muted-foreground">まだありません。毎朝の curate ジョブ（または上のボタン）が作ります。</p>}
      <details className="mt-8" onToggle={onToggleHistory}>
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">過去の記事</summary>
        <div className="mt-2">
          {history === null && historyBusy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />読み込み中…</div>}
          {history && history.items.length === 0 && <div className="text-sm text-muted-foreground">過去の記事はありません。</div>}
          {history?.items.map((d) => <Day key={d.date} day={d} onPatch={patch} />)}
          {history?.next && (
            <Button className="mt-3" variant="outline" loading={historyBusy} onClick={() => loadHistory(history.next!)}>もっと見る（{history.items.length} 日分まで表示中）</Button>
          )}
        </div>
      </details>
    </>
  );
}

const counts = (d: ArticleDay) => {
  const picks = d.items.filter((i) => i.picked);
  return { picks, rest: d.items.filter((i) => !i.picked), opened: d.items.filter((i) => i.opened_at).length };
};

/** One day: the picks, then the rest of the candidates behind <details>. The latest day is open, older ones collapsed. */
function Day({ day, onPatch, open }: { day: ArticleDay; onPatch: (date: string, item: ArticleItem) => void; open?: boolean }) {
  const { picks, rest, opened } = counts(day);
  const head = `${day.date}（${picks.length} 件 / 候補 ${day.items.length} 件${opened ? `・開いた ${opened}` : ""}）`;
  const body = (
    <>
      <ul className="space-y-2.5">{picks.map((it) => <Row key={it.id} date={day.date} it={it} onPatch={onPatch} />)}</ul>
      {picks.length === 0 && <p className="text-sm text-muted-foreground">選ばれた記事はありません。</p>}
      {rest.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">その他の候補 {rest.length} 件（開くと次回の選別の材料になります）</summary>
          <ul className="mt-2 space-y-1">{rest.map((it) => <Row key={it.id} date={day.date} it={it} onPatch={onPatch} compact />)}</ul>
        </details>
      )}
      {day.warnings?.length ? <p className="mt-2 text-xs text-muted-foreground">選別の注意: {day.warnings.join("・")}</p> : null}
    </>
  );
  if (open) return <section><Section>{head}</Section>{body}</section>;
  return (
    <details className="border-b py-1.5">
      <summary className="cursor-pointer text-sm">{head}</summary>
      <div className="mt-2 mb-3">{body}</div>
    </details>
  );
}

const REACTION_LABEL: Record<string, string> = { saved: "取り込んだ", dismissed: "興味なし" };

/** One article: title link (new tab; the click records `opened`), feed / reason / topics, and the two buttons. */
function Row({ date, it, onPatch, compact }: { date: string; it: ArticleItem; onPatch: (date: string, item: ArticleItem) => void; compact?: boolean }) {
  const [which, setWhich] = useState<ArticleReaction | null>(null);
  const react = useAction(async (reaction: ArticleReaction) => {
    setWhich(reaction);
    const r = await api.articleReact({ date, id: it.id, reaction });
    onPatch(date, r.item);
    return r;
  }, { success: (r) => (r.job ? `取り込みを投入しました（ジョブ ${r.job.id.slice(0, 8)}）` : "記録しました") });
  // `opened` is fire-and-forget: the tab opens either way, and the row turns "opened" when the API answers.
  const opened = () => { if (!it.opened_at) api.articleReact({ date, id: it.id, reaction: "opened" }).then((r) => onPatch(date, r.item)).catch(() => {}); };
  const done = it.reaction === "saved" || it.reaction === "dismissed";
  return (
    <li className={cn("flex flex-wrap items-start gap-x-2 gap-y-1", (it.reaction === "dismissed") && "opacity-50")}>
      <span className="min-w-0 flex-1">
        <a href={it.url} target="_blank" rel="noreferrer" onClick={opened} className={cn(!compact && "font-medium", it.opened_at && "text-muted-foreground")}>{it.title}</a>
        <span className="ml-1.5 text-xs text-muted-foreground">{it.feed}{it.published ? ` · ${it.published}` : ""}{it.opened_at ? " · 開いた" : ""}</span>
        {!compact && it.basis === "general" && <Chip className="ml-1.5">一般</Chip>}
        {!compact && it.reason && <div className="text-sm text-muted-foreground">{it.reason}</div>}
        {!compact && it.topics?.length ? <div className="mt-0.5 flex flex-wrap gap-1">{it.topics.map((t) => <Chip key={t}>{t}</Chip>)}</div> : null}
      </span>
      {done ? <Chip>{REACTION_LABEL[it.reaction!] ?? it.reaction}</Chip> : (
        <span className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={react.pending} loading={react.pending && which === "saved"} onClick={() => react.run("saved")} title="本文を取り込んで ingest に回す（学習ノートなどになる）">{!(react.pending && which === "saved") && <InboxIcon data-icon="inline-start" />}取り込む</Button>
          <Button size="sm" variant="ghost" disabled={react.pending} loading={react.pending && which === "dismissed"} onClick={() => react.run("dismissed")}>{!(react.pending && which === "dismissed") && <XIcon data-icon="inline-start" />}興味なし</Button>
        </span>
      )}
    </li>
  );
}
