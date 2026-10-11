import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ChatMessage, type Job } from "../api";
import { Err } from "../components/ui";

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
  const send = async () => {
    if (!q.trim()) return;
    try { const r = await api.ask(q.trim()); setQ(""); setPending(r.job); load(); } catch (e) { setErr(e); }
  };
  return (
    <div className="chat">
      <h2>チャット</h2>
      <p className="muted small">質問は Mac のワーカーが <code>ask</code> スキルで処理します。Mac が起きていないときは待機になります。</p>
      {msgs.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          {m.text}
          {m.role === "assistant" && JSON.parse(m.sources || "[]").length > 0 && (
            <div className="small muted" style={{ marginTop: 6 }}>根拠: {(JSON.parse(m.sources) as string[]).map((s) => <Link key={s} to={`/note/${s}`} style={{ marginRight: 8 }}>{s.split("/").pop()}</Link>)}</div>
          )}
        </div>
      ))}
      {pending && <div className="msg assistant muted">考え中…（ジョブ {pending.id.slice(0, 8)}）</div>}
      <div ref={end} />
      <Err e={err} />
      <div className="toolbar" style={{ marginTop: 16 }}>
        <input type="text" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="評価 4 以上のホラー小説は？ / Netflix はいくら？" />
        <button onClick={send} disabled={!!pending}>送信</button>
      </div>
    </div>
  );
}
