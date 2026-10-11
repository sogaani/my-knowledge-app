import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Job } from "../api";
import { Err, fmtDate, Status } from "../components/ui";

const SKILLS = ["review", "kb-maintain", "subscription-audit", "finance-review", "recommend", "trade-plan", "market-scan"];

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sp, setSp] = useSearchParams();
  const [err, setErr] = useState<unknown>(null);
  const [skill, setSkill] = useState(SKILLS[0]); const [args, setArgs] = useState("");
  const sel = jobs.find((j) => j.id === sp.get("id"));
  const load = () => api.jobs().then(setJobs).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const run = () => api.runJob(skill === "recommend" ? "recommend" : "skill", { name: skill, args }).then(load).catch(setErr);
  return (
    <>
      <h2>ジョブ</h2>
      <div className="toolbar">
        <select value={skill} onChange={(e) => setSkill(e.target.value)}>{SKILLS.map((s) => <option key={s}>{s}</option>)}</select>
        <input type="text" placeholder="引数（例: weekly）" value={args} onChange={(e) => setArgs(e.target.value)} />
        <button className="ghost" onClick={run}>実行</button>
        <button className="ghost" onClick={() => api.sync().then(load).catch(setErr)}>git pull</button>
        <button className="ghost" onClick={() => api.build().then(load).catch(setErr)}>kb build</button>
      </div>
      <Err e={err} />
      <div className="two">
        <div className="tablewrap"><table><thead><tr><th>作成</th><th>種別</th><th>状態</th><th></th></tr></thead><tbody>
          {jobs.map((j) => <tr key={j.id} style={{ background: j.id === sel?.id ? "var(--chip)" : undefined }}><td className="small muted">{fmtDate(j.created_at)}</td><td>{j.kind}{j.kind === "skill" && <span className="muted small"> {JSON.parse(j.payload).name}</span>}</td><td><Status s={j.status} /></td><td><button className="ghost small" onClick={() => setSp({ id: j.id })}>詳細</button></td></tr>)}
        </tbody></table></div>
        <div>
          {sel ? (<>
            <h3>{sel.kind} <span className="muted small">{sel.id}</span></h3>
            <p className="small muted">{fmtDate(sel.created_at)} → {sel.finished_at ? fmtDate(sel.finished_at) : "…"} {sel.commit && <>· commit {sel.commit.slice(0, 7)}</>}</p>
            <div className="log">{sel.log || "(ログなし)"}</div>
            {sel.result && <><h3>結果</h3><div className="log">{pretty(sel.result)}</div></>}
          </>) : <p className="muted">ジョブを選ぶとログが出ます</p>}
        </div>
      </div>
    </>
  );
}
const pretty = (s: string) => { try { const v = JSON.parse(s); return typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { return s; } };
