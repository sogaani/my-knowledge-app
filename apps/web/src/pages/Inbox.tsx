import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Job } from "@/api";
import { Err, fmtDate, PageTitle, Section, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/lib/useAction";

export default function Inbox() {
  const [url, setUrl] = useState(""); const [text, setText] = useState(""); const [title, setTitle] = useState("");
  // Files live in state, not a ref: shadcn's Input does not forward refs on React 18. Bumping fileKey clears the picker.
  const [files, setFiles] = useState<File[]>([]); const [fileKey, setFileKey] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const load = () => api.jobs().then((j) => setJobs(j.filter((x) => x.kind === "ingest").slice(0, 10))).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    // bookmarklet / share: /inbox?url=...&title=...
    const sp = new URLSearchParams(location.search);
    if (sp.get("url")) setUrl(sp.get("url")!); if (sp.get("title")) setTitle(sp.get("title")!); if (sp.get("text")) setText(sp.get("text")!);
  }, []);
  const submit = useAction(async () => {
    const fd = new FormData();
    if (url.trim()) fd.append("url", url.trim());
    if (text.trim()) fd.append("text", title.trim() ? `# ${title.trim()}\n\n${text}` : text);
    for (const f of files) fd.append("file", f);
    await api.inboxForm(fd);
    setUrl(""); setText(""); setTitle(""); setFiles([]); setFileKey((k) => k + 1);
    load();
  }, { success: "inbox に入れました。ワーカーが取り込みます" });
  const runIngest = useAction(async () => { await api.runJob("ingest"); load(); }, { success: "ingest ジョブを投入しました" });
  const empty = !url.trim() && !text.trim() && files.length === 0;
  const bookmarklet = `javascript:location.href='${location.origin}/inbox?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)`;
  return (
    <>
      <PageTitle>投げ込み</PageTitle>
      <p className="mb-4 text-sm text-muted-foreground">URL・メモ・ファイルを inbox に入れると、Mac のワーカーが <code>ingest</code> スキルで Bronze と Silver に整理します。</p>
      <form
        className="grid max-w-[760px] grid-cols-1 items-start gap-x-3 gap-y-2 md:grid-cols-[90px_1fr]"
        onSubmit={(e) => { e.preventDefault(); if (!empty) submit.run(); }}
      >
        <Label htmlFor="in-url" className="md:pt-2">URL</Label>
        <Input id="in-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={submit.pending} />
        <Label htmlFor="in-title" className="md:pt-2">タイトル</Label>
        <Input id="in-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="メモの見出し（任意）" disabled={submit.pending} />
        <Label htmlFor="in-text" className="md:pt-2">メモ</Label>
        <Textarea id="in-text" className="min-h-28" value={text} onChange={(e) => setText(e.target.value)} placeholder="「残穢 読みたい」「Netflix 値上げ 1,890円に」など何でも" disabled={submit.pending} />
        <Label htmlFor="in-file" className="md:pt-2">ファイル</Label>
        <Input key={fileKey} id="in-file" type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} disabled={submit.pending} />
        <span className="hidden md:block" />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" loading={submit.pending} disabled={empty}>{submit.pending ? "送信中…" : "inbox に入れる"}</Button>
          <Button type="button" variant="outline" loading={runIngest.pending} onClick={() => runIngest.run()}>Mac の inbox も整理する</Button>
        </div>
      </form>
      <Err e={err} />
      <p className="mt-4 text-sm text-muted-foreground">ブックマークレット: <a href={bookmarklet} onClick={(e) => e.preventDefault()}>+kb</a>（このリンクをブックマークバーへドラッグ）</p>
      <Section>最近の取り込み</Section>
      <Table>
        <TableHeader><TableRow><TableHead>作成</TableHead><TableHead>内容</TableHead><TableHead>状態</TableHead><TableHead>結果</TableHead></TableRow></TableHeader>
        <TableBody>
          {jobs.map((j) => (
            <TableRow key={j.id}>
              <TableCell className="text-muted-foreground">{fmtDate(j.created_at)}</TableCell>
              <TableCell className="whitespace-normal">{(JSON.parse(j.payload).items ?? []).map((i: { name: string }) => i.name).join(", ") || "inbox"}</TableCell>
              <TableCell><Status s={j.status} /></TableCell>
              <TableCell><Link to={`/jobs?id=${j.id}`}>ログ</Link>{j.commit && <span className="text-muted-foreground"> {j.commit.slice(0, 7)}</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
