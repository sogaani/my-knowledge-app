import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { GitPullRequestArrowIcon, HammerIcon, PlayIcon } from "lucide-react";
import { api, type Job } from "@/api";
import { Choice, Err, fmtDate, Log, PageTitle, Section, Status, Toolbar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

const SKILLS = ["review", "kb-maintain", "subscription-audit", "finance-review", "recommend", "trade-plan", "market-scan"];

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sp, setSp] = useSearchParams();
  const [err, setErr] = useState<unknown>(null);
  const [skill, setSkill] = useState(SKILLS[0]); const [args, setArgs] = useState("");
  const sel = jobs.find((j) => j.id === sp.get("id"));
  const load = () => api.jobs().then(setJobs).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  const run = useAction(async () => {
    const j = await api.runJob(skill === "recommend" ? "recommend" : "skill", { name: skill, args });
    load(); setSp({ id: j.id });
    return j;
  }, { success: (j) => `${skill} を投入しました（${j.id.slice(0, 8)}）` });
  const sync = useAction(async () => { const r = await api.sync(); load(); return r; }, { success: (r) => (r.changed ? "git pull: 更新を取り込みました" : "git pull: 変更なし") });
  const build = useAction(async () => { const r = await api.build(); load(); return r; }, { success: (r) => `kb build: ${r.files.length} ファイル更新` });
  return (
    <>
      <PageTitle>ジョブ</PageTitle>
      <Toolbar>
        <Choice value={skill} onChange={setSkill} options={SKILLS} disabled={run.pending} />
        <form className="contents" onSubmit={(e) => { e.preventDefault(); run.run(); }}>
          <Input className="w-48" placeholder="引数（例: weekly）" value={args} onChange={(e) => setArgs(e.target.value)} disabled={run.pending} />
          <Button type="submit" loading={run.pending}>{!run.pending && <PlayIcon data-icon="inline-start" />}実行</Button>
        </form>
        <Button variant="outline" loading={sync.pending} onClick={() => sync.run()}>{!sync.pending && <GitPullRequestArrowIcon data-icon="inline-start" />}git pull</Button>
        <Button variant="outline" loading={build.pending} onClick={() => build.run()}>{!build.pending && <HammerIcon data-icon="inline-start" />}kb build</Button>
      </Toolbar>
      <Err e={err} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Table>
          <TableHeader><TableRow><TableHead>作成</TableHead><TableHead>種別</TableHead><TableHead>状態</TableHead></TableRow></TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id} onClick={() => setSp({ id: j.id })} className={cn("cursor-pointer", j.id === sel?.id && "bg-muted")} data-state={j.id === sel?.id ? "selected" : undefined}>
                <TableCell className="text-muted-foreground">{fmtDate(j.created_at)}</TableCell>
                <TableCell>{j.kind}{j.kind === "skill" && <span className="text-muted-foreground"> {JSON.parse(j.payload).name}</span>}</TableCell>
                <TableCell><Status s={j.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="min-w-0">
          {sel ? (<>
            <h3 className="mb-1 flex flex-wrap items-center gap-2 text-base font-semibold">{sel.kind} <Status s={sel.status} /> <span className="text-xs font-normal text-muted-foreground">{sel.id}</span></h3>
            <p className="mb-2 text-sm text-muted-foreground">{fmtDate(sel.created_at)} → {sel.finished_at ? fmtDate(sel.finished_at) : "…"} {sel.commit && <>· commit {sel.commit.slice(0, 7)}</>}</p>
            <Log>{sel.log || "(ログなし)"}</Log>
            {sel.result && <><Section>結果</Section><Log>{pretty(sel.result)}</Log></>}
          </>) : <p className="text-muted-foreground">ジョブを選ぶとログが出ます</p>}
        </div>
      </div>
    </>
  );
}
const pretty = (s: string) => { try { const v = JSON.parse(s); return typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { return s; } };
