import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SendIcon } from "lucide-react";
import { api, type ChatExchange, type ChatMessage, type Job, type NoteHead } from "@/api";
import Md, { routeFor } from "@/components/Md";
import { Chip, Err, PageTitle, fmtDate } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/lib/useAction";
import { typeLabel } from "../App";

const inFlight = (j: Job | null) => !!j && (j.status === "queued" || j.status === "running");
/** Older exchanges are fetched this many at a time, and only once the 過去の質疑応答 section is opened. */
const PAGE = 10;

/**
 * One question, one answer: the newest exchange sits under the input, and nothing else loads until the user opens the
 * history. Each question is its own ask job (no conversation is carried over), and the page is laid out to say so.
 */
export default function Chat() {
  const [latest, setLatest] = useState<ChatExchange | null>(null);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<Job | null>(null);
  const [err, setErr] = useState<unknown>(null);
  // Older exchanges: null until the section is opened for the first time.
  const [history, setHistory] = useState<{ items: ChatExchange[]; next: string | null } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const loadLatest = async () => {
    try {
      const r = await api.chat({ limit: 1 });
      const x = r.items[0] ?? null;
      setLatest(x);
      // Coming back to the page while an answer is still being worked on: pick up the wait where it was left.
      if (x && !x.answer && x.job_id) {
        const j = await api.job(x.job_id).catch(() => null);
        if (inFlight(j)) setPending(j);
      }
    } catch (e) { setErr(e); }
  };
  useEffect(() => { loadLatest(); }, []);

  // Long-poll /jobs/:id/wait (the API wakes it on the worker's `done`), so the answer shows the moment it lands.
  useEffect(() => {
    if (!pending) return;
    let live = true;
    (async () => {
      while (live) {
        const j = await api.jobWait(pending.id, 25).catch(() => null);
        if (!live) return;
        if (!j) { await new Promise((r) => setTimeout(r, 3000)); continue; } // network hiccup: try again shortly
        if (!inFlight(j)) { setPending(null); loadLatest(); return; }
      }
    })();
    return () => { live = false; };
  }, [pending?.id]);

  const send = useAction(async (question: string) => {
    const r = await api.ask(question);
    setQ("");
    // The new question becomes the latest exchange; the previous one slides into the history if that is already loaded.
    if (latest) setHistory((h) => (h ? { ...h, items: [latest, ...h.items] } : h));
    setLatest({ job_id: r.job.id, question: r.message, answer: null, created_at: r.message.created_at });
    setPending(r.job);
  });
  // Locked from submit until the worker's answer lands: one question in flight at a time.
  const locked = send.pending || !!pending;

  const loadHistory = async (before: string | undefined) => {
    setHistoryBusy(true);
    try {
      const r = await api.chat({ limit: PAGE, before });
      setHistory((h) => ({ items: before && h ? [...h.items, ...r.items] : r.items, next: r.next }));
    } catch (e) { setErr(e); } finally { setHistoryBusy(false); }
  };
  const onToggleHistory = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && history === null && !historyBusy) loadHistory(latest?.created_at);
  };

  return (
    <div className="max-w-[760px]">
      <PageTitle>チャット</PageTitle>
      <p className="text-sm text-muted-foreground">1 問 1 答です。前の質問は引き継ぎません。質問は Mac のワーカーが <code>ask</code> スキルで処理します。Mac が起きていないときは待機になります。回答が届くと通知します（通知を有効にしている場合）。</p>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) send.run(q.trim()); }}>
        <Input className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} disabled={locked} placeholder="評価 4 以上のホラー小説は？ / Netflix はいくら？" />
        <Button type="submit" loading={locked} disabled={!q.trim()}>{!locked && <SendIcon data-icon="inline-start" />}送信</Button>
      </form>
      <Err e={err} />
      {latest && (
        <div className="mt-4">
          <Question m={latest.question} />
          {latest.answer ? <Answer m={latest.answer} /> : pending ? (
            <div className="my-2 mr-10 flex items-center gap-2 rounded-xl border bg-card px-3.5 py-2.5 text-muted-foreground md:mr-16">
              <Spinner />考え中…（ジョブ {pending.id.slice(0, 8)}）
            </div>
          ) : (
            <div className="my-2 mr-10 rounded-xl border bg-card px-3.5 py-2.5 text-sm text-muted-foreground md:mr-16">回答はまだありません（ジョブは終了しています）。</div>
          )}
        </div>
      )}
      <details className="mt-6" onToggle={onToggleHistory}>
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">過去の質疑応答</summary>
        <div className="mt-2">
          {history === null && historyBusy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />読み込み中…</div>}
          {history && history.items.length === 0 && <div className="text-sm text-muted-foreground">過去の質疑応答はありません。</div>}
          {history?.items.map((x) => (
            <details key={x.question.id} className="border-b py-1.5">
              <summary className="cursor-pointer text-sm">
                <span className="mr-2 text-xs text-muted-foreground">{fmtDate(x.created_at)}</span>{x.question.text}
              </summary>
              <div className="mt-1">
                {x.answer ? <Answer m={x.answer} /> : <div className="my-2 text-sm text-muted-foreground">回答なし</div>}
              </div>
            </details>
          ))}
          {history?.next && (
            <Button className="mt-3" variant="outline" loading={historyBusy} onClick={() => loadHistory(history.next!)}>もっと見る（{history.items.length} 件まで表示中）</Button>
          )}
        </div>
      </details>
    </div>
  );
}

function Question({ m }: { m: ChatMessage }) {
  return <div className="my-2 ml-10 whitespace-pre-wrap rounded-xl bg-muted px-3.5 py-2.5 md:ml-16">{m.text}</div>;
}

function Answer({ m }: { m: ChatMessage }) {
  return (
    <div className="my-2 mr-10 rounded-xl border bg-card px-3.5 py-2.5 md:mr-16">
      <Md text={m.text} basePath="" />
      <Sources notes={sourcesOf(m)} />
    </div>
  );
}

/** The API resolves `sources` to titles (`sourceNotes`); an older answer without them falls back to the file names. */
function sourcesOf(m: ChatMessage): NoteHead[] {
  if (m.sourceNotes) return m.sourceNotes;
  try {
    const v = JSON.parse(m.sources || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((p) => ({ path: p, type: "", title: p.split("/").pop()?.replace(/\.md$/, "") ?? p, status: "", summary: "" })) : [];
  } catch { return []; }
}

/** 根拠: one card per note the answer was built from, with its title and summary. */
function Sources({ notes }: { notes: NoteHead[] }) {
  if (!notes.length) return null;
  return (
    <div className="mt-2 border-t pt-2">
      <div className="mb-1 text-xs text-muted-foreground">根拠</div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {notes.map((n) => (
          <Link key={n.path} to={routeFor(n.path)} className="block rounded-lg border px-2.5 py-1.5 text-sm no-underline transition-colors hover:bg-muted hover:no-underline">
            <div className="flex items-center gap-1.5"><span className="truncate font-medium">{n.title}</span>{n.type && <Chip>{typeLabel(n.type)}</Chip>}</div>
            {n.summary && <div className="line-clamp-2 text-xs text-muted-foreground">{n.summary}</div>}
          </Link>
        ))}
      </div>
    </div>
  );
}
