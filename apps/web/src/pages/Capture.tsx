import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Capture } from "@/api";
import { Choice, Err, fmtDate, PageTitle, Section, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/lib/useAction";

/** The research service a shared link points at (the API's capture platforms); anything else is a plain web page. */
export function platformOf(url: string): string {
  let host = "";
  try { host = new URL(url).hostname; } catch { return "web"; }
  if (/(^|\.)gemini\.google\.com$/.test(host) || /^g\.co$/.test(host)) return "gemini";
  if (/(^|\.)notebooklm\.google\.com$|(^|\.)notebook\.google\.com$/.test(host)) return "notebooklm";
  if (/(^|\.)claude\.ai$/.test(host)) return "claude";
  if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(host)) return "chatgpt";
  if (/(^|\.)perplexity\.ai$/.test(host)) return "perplexity";
  return "web";
}
/** Share sheets put the link in `text` as often as in `url`: lift the first URL out of the text when `url` is empty. */
export function splitShare(p: { title?: string; text?: string; url?: string }): { title: string; text: string; url: string } {
  let url = (p.url ?? "").trim(), text = (p.text ?? "").trim();
  if (!url) {
    const m = /https?:\/\/\S+/.exec(text);
    if (m) { url = m[0]; text = text.replace(m[0], "").trim(); }
  }
  return { title: (p.title ?? "").trim(), text, url };
}

const STATUS_LABEL: Record<string, string> = { queued: "取り込み待ち", running: "取り込み中", done: "取り込み済み", stored: "保存のみ", failed: "失敗" };
export const CaptureStatus = ({ c }: { c: Capture }) => (
  <span className="inline-flex items-center gap-1.5"><Status s={c.status} /><span className="text-xs text-muted-foreground">{STATUS_LABEL[c.status] ?? ""}</span></span>
);

/**
 * Capture: the phone's share target (manifest `share_target` → /capture?title&text&url) and the list of everything
 * captured from every client (Chrome extension, kb capture, here) with its shared status.
 */
export default function CapturePage() {
  const [form, setForm] = useState(() => splitShare(Object.fromEntries(new URLSearchParams(location.search))));
  const [area, setArea] = useState("");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<Capture[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const load = () => api.captures().then((r) => setItems(r.items)).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const submit = useAction(async () => {
    const r = await api.capture({
      client: "share", platform: platformOf(form.url), title: form.title || undefined, url: form.url || undefined,
      markdown: form.text, area: area || undefined, note: note || undefined, captured_at: new Date().toISOString(),
    });
    setForm({ title: "", text: "", url: "" }); setNote("");
    history.replaceState(null, "", "/capture");
    load();
    if (r.duplicate) throw new Error("同じ内容がもう送られています");
  }, { success: "送りました。ワーカーが取り込みます" });
  const empty = !form.text.trim() && !form.url.trim();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <PageTitle>AI の調査を保存</PageTitle>
      <p className="mb-4 text-sm text-muted-foreground">Gemini・Claude・NotebookLM などの調査を KB に送ります。Chrome 拡張・Claude Code（<code>kb capture</code>）・スマホの共有も同じ API に送るので、下の一覧で同じ状態が見えます。</p>
      <form className="grid max-w-[760px] grid-cols-1 items-start gap-x-3 gap-y-2 md:grid-cols-[90px_1fr]" onSubmit={(e) => { e.preventDefault(); if (!empty) submit.run(); }}>
        <Label htmlFor="cap-url" className="md:pt-2">URL</Label>
        <Input id="cap-url" type="url" value={form.url} onChange={set("url")} placeholder="共有リンク（任意）" disabled={submit.pending} />
        <Label htmlFor="cap-title" className="md:pt-2">タイトル</Label>
        <Input id="cap-title" value={form.title} onChange={set("title")} placeholder="何の調査か" disabled={submit.pending} />
        <Label htmlFor="cap-text" className="md:pt-2">本文</Label>
        <Textarea id="cap-text" className="min-h-40" value={form.text} onChange={set("text")} placeholder="回答をコピーして貼る（共有リンクだけでもよい）" disabled={submit.pending} />
        <Label htmlFor="cap-note" className="md:pt-2">メモ</Label>
        <Input id="cap-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="なぜ保存するか（任意）" disabled={submit.pending} />
        <Label htmlFor="cap-area" className="md:pt-2">区分</Label>
        <Choice id="cap-area" className="w-40" value={area} onChange={setArea} options={[{ value: "", label: "自動" }, { value: "personal", label: "私用" }, { value: "work", label: "仕事" }]} disabled={submit.pending} />
        <span className="hidden md:block" />
        <div className="pt-1"><Button type="submit" loading={submit.pending} disabled={empty}>{submit.pending ? "送信中…" : "保存する"}</Button></div>
      </form>
      <Err e={err} />
      <Section>保存した調査</Section>
      <Table>
        <TableHeader><TableRow><TableHead>送信</TableHead><TableHead>内容</TableHead><TableHead>状態</TableHead><TableHead>ノート</TableHead></TableRow></TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="text-muted-foreground">{fmtDate(c.created_at)}</TableCell>
              <TableCell className="whitespace-normal">
                {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}
                <span className="ml-1.5 text-xs text-muted-foreground">{c.platform} · {c.client}{c.version > 1 ? ` · v${c.version}` : ""}{c.area ? ` · ${c.area === "work" ? "仕事" : "私用"}` : ""}</span>
              </TableCell>
              <TableCell><CaptureStatus c={c} />{c.error && <div className="text-xs text-destructive">{c.error}</div>}</TableCell>
              <TableCell className="whitespace-normal">
                {c.notes.map((n) => <div key={n.path}><Link to={n.web}>{n.title}</Link></div>)}
                {!c.notes.length && <Link to={`/jobs?id=${c.job_id}`} className="text-xs">ログ</Link>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
