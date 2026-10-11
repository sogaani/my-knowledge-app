import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Home as HomeData } from "../api";
import { Err, NoteLink, Status } from "../components/ui";
import { typeLabel } from "../App";

export default function Home() {
  const [d, setD] = useState<HomeData | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => api.home().then(setD).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  if (err) return <Err e={err} />;
  if (!d) return <p className="muted">読み込み中…</p>;
  const running = d.jobs.filter((j) => j.status === "queued" || j.status === "running");
  return (
    <>
      <h2>ホーム</h2>
      <div className="cards">
        <div className="card"><div className="big">¥{d.monthlySubscriptions.toLocaleString()}</div><div className="sub">サブスク 月額換算（{d.activeSubscriptions} 件）</div><Link to="/notes/subscription" className="small">一覧 →</Link></div>
        <div className="card"><div className="big">{d.books.read ?? 0}</div><div className="sub">読了 / 読書中 {d.books.reading ?? 0} / 積読 {d.books.want ?? 0}</div><Link to="/notes/book" className="small">読書 →</Link></div>
        <div className="card"><div className="big">{d.media.watched ?? 0}</div><div className="sub">視聴済み / 視聴中 {d.media.watching ?? 0} / 観たい {d.media.want ?? 0}</div><Link to="/notes/media" className="small">映画・ドラマ →</Link></div>
        <div className="card"><div className="big">{d.projects.length}</div><div className="sub">進行中プロジェクト</div><Link to="/notes/project" className="small">一覧 →</Link></div>
        <div className="card"><div className="big">{running.length}</div><div className="sub">実行中・待機中のジョブ</div><Link to="/jobs" className="small">ジョブ →</Link></div>
      </div>
      <div className="two">
        <section>
          <h3>進行中プロジェクト</h3>
          {d.projects.length === 0 && <p className="muted">なし</p>}
          <ul>{d.projects.map((p) => <li key={p.path}><NoteLink n={p} /> {p.fm.due ? <span className="muted small">期限 {String(p.fm.due)}</span> : null}<div className="small muted">{p.summary}</div></li>)}</ul>
          <h3>保守</h3>
          <ul className="small">
            {Object.entries(d.lint).filter(([, v]) => v.length).map(([k, v]) => <li key={k}><b>{k}</b>: {v.length} 件 <span className="muted">{v.slice(0, 3).join(", ")}{v.length > 3 ? " …" : ""}</span></li>)}
            {Object.values(d.lint).every((v) => v.length === 0) && <li className="muted">問題なし</li>}
          </ul>
        </section>
        <section>
          <h3>最近更新</h3>
          <div className="tablewrap"><table><tbody>
            {d.recent.map((n) => <tr key={n.path}><td className="muted small">{n.updated}</td><td><span className="chip">{typeLabel(n.type)}</span></td><td><NoteLink n={n} /><div className="small muted">{n.summary}</div></td><td><Status s={n.status} /></td></tr>)}
          </tbody></table></div>
        </section>
      </div>
      <p className="small muted">index: {d.head.slice(0, 7) || "(no git)"} · 件数 {d.counts.map((c) => `${typeLabel(c.type)} ${c.c}`).join(" / ")}</p>
    </>
  );
}
