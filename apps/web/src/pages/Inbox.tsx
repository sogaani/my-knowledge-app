import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Job } from "../api";
import { Err, fmtDate, Status } from "../components/ui";

export default function Inbox() {
  const [url, setUrl] = useState(""); const [text, setText] = useState(""); const [title, setTitle] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const load = () => api.jobs().then((j) => setJobs(j.filter((x) => x.kind === "ingest").slice(0, 10))).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    // bookmarklet / share: /inbox?url=...&title=...
    const sp = new URLSearchParams(location.search);
    if (sp.get("url")) setUrl(sp.get("url")!); if (sp.get("title")) setTitle(sp.get("title")!); if (sp.get("text")) setText(sp.get("text")!);
  }, []);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      if (url.trim()) fd.append("url", url.trim());
      if (text.trim()) fd.append("text", title.trim() ? `# ${title.trim()}\n\n${text}` : text);
      for (const f of file.current?.files ?? []) fd.append("file", f);
      await api.inboxForm(fd);
      setUrl(""); setText(""); setTitle(""); if (file.current) file.current.value = "";
      load();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const runIngest = () => api.runJob("ingest").then(load).catch(setErr);
  const bookmarklet = `javascript:location.href='${location.origin}/inbox?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)`;
  return (
    <>
      <h2>投げ込み</h2>
      <p className="muted small">URL・メモ・ファイルを inbox に入れると、Mac のワーカーが <code>ingest</code> スキルで Bronze と Silver に整理します。</p>
      <div className="fm" style={{ gridTemplateColumns: "90px 1fr" }}>
        <label>URL</label><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <label>タイトル</label><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="メモの見出し（任意）" />
        <label>メモ</label><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="「残穢 読みたい」「Netflix 値上げ 1,890円に」など何でも" />
        <label>ファイル</label><input type="file" multiple ref={file} />
        <span /><span><button disabled={busy} onClick={submit}>inbox に入れる</button> <button className="ghost" onClick={runIngest}>Mac の inbox も整理する</button></span>
      </div>
      <Err e={err} />
      <p className="small muted">ブックマークレット: <a href={bookmarklet} onClick={(e) => e.preventDefault()}>+kb</a>（このリンクをブックマークバーへドラッグ）</p>
      <h3>最近の取り込み</h3>
      <div className="tablewrap"><table><thead><tr><th>作成</th><th>内容</th><th>状態</th><th>結果</th></tr></thead><tbody>
        {jobs.map((j) => <tr key={j.id}><td className="small muted">{fmtDate(j.created_at)}</td><td className="small">{(JSON.parse(j.payload).items ?? []).map((i: { name: string }) => i.name).join(", ") || "inbox"}</td><td><Status s={j.status} /></td><td className="small"><Link to={`/jobs?id=${j.id}`}>ログ</Link>{j.commit && <span className="muted"> {j.commit.slice(0, 7)}</span>}</td></tr>)}
      </tbody></table></div>
    </>
  );
}
