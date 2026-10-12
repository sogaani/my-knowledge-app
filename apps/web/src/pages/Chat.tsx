import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SendIcon } from "lucide-react";
import { api, type ChatMessage, type Job } from "@/api";
import { Err, PageTitle } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

export default function Chat() {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<Job | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = () => api.chat().then(setMsgs).catch(setErr);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      const j = await api.job(pending.id).catch(() => null);
      if (j && (j.status === "done" || j.status === "failed")) { setPending(null); load(); }
    }, 3000);
    return () => clearInterval(t);
  }, [pending]);
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
      <p className="text-sm text-muted-foreground">質問は Mac のワーカーが <code>ask</code> スキルで処理します。Mac が起きていないときは待機になります。</p>
      {msgs.map((m) => (
        <div key={m.id} className={cn("my-2 rounded-xl px-3.5 py-2.5 whitespace-pre-wrap", m.role === "user" ? "ml-10 bg-muted md:ml-16" : "mr-10 border bg-card md:mr-16")}>
          {m.text}
          {m.role === "assistant" && JSON.parse(m.sources || "[]").length > 0 && (
            <div className="mt-1.5 text-sm text-muted-foreground">根拠: {(JSON.parse(m.sources) as string[]).map((s) => <Link key={s} to={`/note/${s}`} className="mr-2">{s.split("/").pop()}</Link>)}</div>
          )}
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
