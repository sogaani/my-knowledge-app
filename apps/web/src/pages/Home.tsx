import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Home as HomeData } from "@/api";
import { Chip, Err, Loading, NoteLink, PageTitle, Section, Status } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { typeLabel } from "../App";

const Stat = ({ big, sub, to, link }: { big: React.ReactNode; sub: React.ReactNode; to: string; link: string }) => (
  <Card className="gap-1 py-4">
    <CardContent className="space-y-0.5">
      <div className="text-2xl font-semibold">{big}</div>
      <div className="text-sm text-muted-foreground">{sub}</div>
      <Link to={to} className="text-sm">{link} →</Link>
    </CardContent>
  </Card>
);

export default function Home() {
  const [d, setD] = useState<HomeData | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => api.home().then(setD).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  if (err) return <Err e={err} />;
  if (!d) return <><PageTitle>ホーム</PageTitle><Loading /></>;
  const running = d.jobs.filter((j) => j.status === "queued" || j.status === "running");
  return (
    <>
      <PageTitle>ホーム</PageTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        <Stat big={`¥${d.monthlySubscriptions.toLocaleString()}`} sub={`サブスク 月額換算（${d.activeSubscriptions} 件）`} to="/notes/subscription" link="一覧" />
        <Stat big={d.books.read ?? 0} sub={`読了 / 読書中 ${d.books.reading ?? 0} / 積読 ${d.books.want ?? 0}`} to="/notes/book" link="読書" />
        <Stat big={d.media.watched ?? 0} sub={`視聴済み / 視聴中 ${d.media.watching ?? 0} / 観たい ${d.media.want ?? 0}`} to="/notes/media" link="映画・ドラマ" />
        <Stat big={d.projects.length} sub="進行中プロジェクト" to="/notes/project" link="一覧" />
        <Stat big={running.length} sub="実行中・待機中のジョブ" to="/jobs" link="ジョブ" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <Section>進行中プロジェクト</Section>
          {d.projects.length === 0 && <p className="text-muted-foreground">なし</p>}
          <ul className="list-disc space-y-1 pl-5">{d.projects.map((p) => <li key={p.path}><NoteLink n={p} /> {p.fm.due ? <span className="text-sm text-muted-foreground">期限 {String(p.fm.due)}</span> : null}<div className="text-sm text-muted-foreground">{p.summary}</div></li>)}</ul>
          <Section>保守</Section>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {Object.entries(d.lint).filter(([, v]) => v.length).map(([k, v]) => <li key={k}><b>{k}</b>: {v.length} 件 <span className="text-muted-foreground">{v.slice(0, 3).join(", ")}{v.length > 3 ? " …" : ""}</span></li>)}
            {Object.values(d.lint).every((v) => v.length === 0) && <li className="text-muted-foreground">問題なし</li>}
          </ul>
        </section>
        <section className="min-w-0">
          <Section>最近更新</Section>
          <Table><TableBody>
            {d.recent.map((n) => (
              <TableRow key={n.path}>
                <TableCell className="align-top text-muted-foreground">{n.updated}</TableCell>
                <TableCell className="align-top"><Chip>{typeLabel(n.type)}</Chip></TableCell>
                <TableCell className="whitespace-normal"><NoteLink n={n} /><div className="text-sm text-muted-foreground">{n.summary}</div></TableCell>
                <TableCell className="align-top"><Status s={n.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody></Table>
        </section>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">index: {d.head.slice(0, 7) || "(no git)"}{d.unpushed ? ` · 未 push ${d.unpushed} 件` : ""}{d.pushError && <span className="text-destructive"> · push 失敗: {d.pushError}</span>} · 件数 {d.counts.map((c) => `${typeLabel(c.type)} ${c.c}`).join(" / ")}</p>
    </>
  );
}
