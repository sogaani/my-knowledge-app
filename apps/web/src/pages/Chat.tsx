import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SendIcon } from "lucide-react";
import { api, type ChatMessage, type Job, type NoteHead } from "@/api";
import Md, { routeFor } from "@/components/Md";
import { Chip, Err, PageTitle } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";
import { typeLabel } from "../App";

const inFlight = (j: Job | null) => !!j && (j.status === "queued" || j.status === "running");

export default function Chat() {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<Job | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = async () => {
    try {
      const m = await api.chat();
      setMsgs(m);
      // Coming back to the page while an answer is still being worked on: pick up the wait where it was left.
      const last = m[m.length - 1];
      if (last?.role === "user" && last.job_id) {
        const j = await api.job(last.job_id).catch(() => null);
        if (inFlight(j)) setPending(j);
      }
    } catch (e) { setErr(e); }
  };
  useEffect(() => { load(); }, []);
  // Long-poll /jobs/:id/wait (the API wakes it on the worker's `done`), so the answer shows the moment it lands.
  useEffect(() => {
    if (!pending) return;
    let live = true;
    (async () => {
      while (live) {
        const j = await api.jobWait(pending.id, 25).catch(() => null);
        if (!live) return;
        if (!j) { await new Promise((r) => setTimeout(r, 3000)); continue; } // network hiccup: try again shortly
        if (!inFlight(j)) { setPending(null); load(); return; }
      }
    })();
    return () => { live = false; };
  }, [pending?.id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, pending]);
  const send = useAction(async (question: string) => {
    const r = await api.ask(question);
    setQ(""); setPending(r.job); load();
  });
  // Locked from submit until the worker's answer lands: one question in flight at a time.
  const locked = send.pending || !!pending;
  return (
    <div className="max-w-[760px]">
      <PageTitle>チャット</PageTitle>
      <p className="text-sm text-muted-foreground">質問は Mac のワーカーが <code>ask</code> スキルで処理します。Mac が起きていないときは待機になります。回答が届くと通知します（通知を有効にしている場合）。</p>
      {msgs.map((m) => (
        <div key={m.id} className={cn("my-2 rounded-xl px-3.5 py-2.5", m.role === "user" ? "ml-10 bg-muted whitespace-pre-wrap md:ml-16" : "mr-10 border bg-card md:mr-16")}>
          {m.role === "assistant" ? <Md text={m.text} basePath="" /> : m.text}
          {m.role === "assistant" && <Sources notes={sourcesOf(m)} />}
        </div>
      ))}
      {pending && (
        <div className="my-2 mr-10 flex items-center gap-2 rounded-xl border bg-card px-3.5 py-2.5 text-muted-foreground md:mr-16">
          <Spinner />考え中…（ジョブ {pending.id.slice(0, 8)}）
        </div>
      )}
      <div ref={end} />
      <Err e={err} />
      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) send.run(q.trim()); }}>
        <Input className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} disabled={locked} placeholder="評価 4 以上のホラー小説は？ / Netflix はいくら？" />
        <Button type="submit" loading={locked} disabled={!q.trim()}>{!locked && <SendIcon data-icon="inline-start" />}送信</Button>
      </form>
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
