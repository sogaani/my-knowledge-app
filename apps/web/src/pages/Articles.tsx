import { useEffect, useState } from "react";
import { BookmarkIcon, CheckIcon, InboxIcon, XIcon } from "lucide-react";
import { api, type ArticleDay, type ArticleItem, type ArticleReaction } from "@/api";
import { Chip, Err, Loading, PageTitle, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

/** Older days are fetched this many at a time, and only once the 過去の記事 section is opened. */
const PAGE = 7;

type Queued = { date: string; item: ArticleItem };

/**
 * The read-later queue (every day, oldest first), then the day's RSS picks (900_system/articles/<date>.json, written by
 * the curate job every morning). Only the latest day loads; the rest of that day's candidates and the earlier days sit
 * behind <details> and load on demand. Opening a link records `opened` (that is what teaches the next run); the buttons
 * record `later` (queue) / `saved` (→ ingest) / `dismissed`, and in the queue `done` (read, no note). Nothing in the
 * queue expires: it waits for one of those three.
 */
export default function Articles() {
  const [latest, setLatest] = useState<ArticleDay | null | undefined>(undefined);
  const [later, setLater] = useState<Queued[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [history, setHistory] = useState<{ items: ArticleDay[]; next: string | null } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.articles({ limit: 1 }), api.articlesLater()])
      .then(([r, l]) => { setLater(l.items); setLatest(r.items[0] ?? null); })
      .catch(setErr);
  }, []);
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
  // A reaction updates the item in whichever day holds it (the latest day or one in the history) and the queue:
  // `later` adds it (keeping the queue's order), anything else removes it.
  const patch = (date: string, item: ArticleItem) => {
    const upd = (d: ArticleDay) => (d.date === date ? { ...d, items: d.items.map((i) => (i.id === item.id ? item : i)) } : d);
    setLatest((d) => (d ? upd(d) : d));
    setHistory((h) => (h ? { ...h, items: h.items.map(upd) } : h));
    setLater((q) => {
      const rest = q.filter((e) => !(e.date === date && e.item.id === item.id));
      if (item.reaction !== "later") return rest;
      const i = q.findIndex((e) => e.date === date && e.item.id === item.id);
      return i < 0 ? [...rest, { date, item }] : q.map((e, n) => (n === i ? { date, item } : e));
    });
  };

  if (err) return <Err e={err} />;
  if (latest === undefined) return <><PageTitle>記事</PageTitle><Loading /></>;
  return (
    <>
      <PageTitle sub="RSS の新着から毎朝選んだ記事。開いた・後で読む・取り込んだ・興味なしが次の選別に効きます">記事</PageTitle>
      <div className="mb-2">
        <Button variant="outline" size="sm" loading={refresh.pending} onClick={() => refresh.run()}>curate を実行（Mac ワーカー）</Button>
      </div>
      {later.length > 0 && (
        <section className="mb-8">
          <Section>後で読む（{later.length} 件）</Section>
          <p className="mb-2 text-xs text-muted-foreground">期限では消えません。読んだら「取り込む」「読んだ」「興味なし」のどれかで片づけます。</p>
          <ul className="space-y-2.5">{later.map((e) => <Row key={`${e.date}/${e.item.id}`} date={e.date} it={e.item} onPatch={patch} queue />)}</ul>
        </section>
      )}
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

const REACTION_LABEL: Record<string, string> = { later: "後で読む", saved: "取り込んだ", dismissed: "興味なし", done: "読んだ" };
const shortDate = (iso: string) => { const [, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}`; };

/**
 * One article: title link (new tab; the click records `opened`), feed / reason / topics, and the buttons.
 * In a day list: 取り込む / 後で / 興味なし, replaced by a chip once it has a state (a queued one is acted on from the
 * queue at the top). In the queue (`queue`): 取り込む / 読んだ / 興味なし — 読んだ exists only there.
 */
function Row({ date, it, onPatch, compact, queue }: { date: string; it: ArticleItem; onPatch: (date: string, item: ArticleItem) => void; compact?: boolean; queue?: boolean }) {
  const [which, setWhich] = useState<ArticleReaction | null>(null);
  const react = useAction(async (reaction: ArticleReaction) => {
    setWhich(reaction);
    const r = await api.articleReact({ date, id: it.id, reaction });
    onPatch(date, r.item);
    return r;
  }, { success: (r) => (r.job ? `取り込みを投入しました（ジョブ ${r.job.id.slice(0, 8)}）` : r.item.reaction === "later" ? "後で読むに入れました" : "記録しました") });
  // `opened` is fire-and-forget: the tab opens either way, and the row turns "opened" when the API answers.
  const opened = () => { if (!it.opened_at) api.articleReact({ date, id: it.id, reaction: "opened" }).then((r) => onPatch(date, r.item)).catch(() => {}); };
  const btn = (reaction: ArticleReaction, label: string, icon: React.ReactNode, variant: "outline" | "ghost", title?: string) => (
    <Button size="sm" variant={variant} disabled={react.pending} loading={react.pending && which === reaction} onClick={() => react.run(reaction)} title={title}>
      {!(react.pending && which === reaction) && icon}{label}
    </Button>
  );
  const actions = queue ? (
    <span className="flex gap-1.5">
      {btn("saved", "取り込む", <InboxIcon data-icon="inline-start" />, "outline", "本文を取り込んで ingest に回す（学習ノートなどになる）")}
      {btn("done", "読んだ", <CheckIcon data-icon="inline-start" />, "outline", "読み終えた。ノートにはしない")}
      {btn("dismissed", "興味なし", <XIcon data-icon="inline-start" />, "ghost")}
    </span>
  ) : it.reaction ? <Chip>{REACTION_LABEL[it.reaction] ?? it.reaction}</Chip> : (
    <span className="flex gap-1.5">
      {btn("saved", "取り込む", <InboxIcon data-icon="inline-start" />, "outline", "本文を取り込んで ingest に回す（学習ノートなどになる）")}
      {btn("later", "後で", <BookmarkIcon data-icon="inline-start" />, "outline", "後で読むに入れる（上の一覧に残る）")}
      {btn("dismissed", "興味なし", <XIcon data-icon="inline-start" />, "ghost")}
    </span>
  );
  return (
    <li className={cn("flex flex-wrap items-start gap-x-2 gap-y-1", (it.reaction === "dismissed") && "opacity-50")}>
      <span className="min-w-0 flex-1">
        <a href={it.url} target="_blank" rel="noreferrer" onClick={opened} className={cn(!compact && "font-medium", it.opened_at && "text-muted-foreground")}>{it.title}</a>
        <span className="ml-1.5 text-xs text-muted-foreground">
          {it.feed}{it.published ? ` · ${it.published}` : ""}{queue && it.later_at ? ` · ${shortDate(it.later_at)} から` : ""}{it.opened_at ? " · 開いた" : ""}
        </span>
        {!compact && it.basis === "general" && <Chip className="ml-1.5">一般</Chip>}
        {!compact && it.reason && <div className="text-sm text-muted-foreground">{it.reason}</div>}
        {!compact && !queue && it.topics?.length ? <div className="mt-0.5 flex flex-wrap gap-1">{it.topics.map((t) => <Chip key={t}>{t}</Chip>)}</div> : null}
      </span>
      {actions}
    </li>
  );
}
