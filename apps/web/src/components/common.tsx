import { Link } from "react-router-dom";
import { CircleAlertIcon } from "lucide-react";
import type { NoteSummary } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errMsg } from "@/lib/useAction";
import { cn } from "@/lib/utils";

export const Stars = ({ n }: { n: unknown }) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? <span className="tracking-wider text-warn">{"★".repeat(v)}{"☆".repeat(5 - v)}</span> : null;
};

const STATUS_TONE: Record<string, string> = {
  active: "text-ok", read: "text-ok", watched: "text-ok", done: "text-ok",
  want: "text-muted-foreground", idea: "text-muted-foreground", queued: "text-muted-foreground",
  reading: "text-warn", watching: "text-warn", running: "text-warn",
  failed: "text-destructive", cancelled: "text-destructive", dnf: "text-destructive",
};
/** Note / job status. Queued and running jobs get a spinner so in-flight work is visible at a glance. */
export const Status = ({ s }: { s: string }) =>
  s ? (
    <Badge variant="outline" className={cn("font-normal", STATUS_TONE[s])}>
      {(s === "running" || s === "queued") && <Spinner data-icon="inline-start" />}{s}
    </Badge>
  ) : null;

export const Chip = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <Badge variant="secondary" className={cn("font-normal", className)}>{children}</Badge>
);

export const NoteLink = ({ n }: { n: NoteSummary | { path: string; title: string } }) => <Link to={`/note/${n.path}`}>{n.title}</Link>;

/** Load errors shown inline (action errors go to toasts via useAction). */
export const Err = ({ e }: { e: unknown }) =>
  e ? <p className="my-3 flex items-center gap-2 text-sm text-destructive"><CircleAlertIcon className="size-4 shrink-0" />{errMsg(e)}</p> : null;

export const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div className="space-y-2" aria-busy="true">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-5" style={{ width: `${90 - i * 12}%` }} />)}</div>
);

export const PageTitle = ({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) => (
  <h2 className="mb-4 flex flex-wrap items-baseline gap-x-3 text-2xl font-semibold tracking-tight">{children}{sub ? <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">{sub}</span> : null}</h2>
);

export const Section = ({ children }: { children: React.ReactNode }) => <h3 className="mt-6 mb-2 text-base font-semibold">{children}</h3>;

export const Toolbar = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn("mb-4 flex flex-wrap items-center gap-2", className)}>{children}</div>
);

export const Log = ({ children }: { children: React.ReactNode }) => (
  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{children}</pre>
);

// Radix Select reserves "" for "no value", so an empty option travels as this sentinel.
const EMPTY = "__empty__";
/** shadcn Select over a flat option list; `""` is a valid option value (e.g. "all"). */
export function Choice({ value, onChange, options, className, disabled, id }: {
  value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[];
  className?: string; disabled?: boolean; id?: string;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <Select value={value || EMPTY} onValueChange={(v) => onChange(v === EMPTY ? "" : v)} disabled={disabled}>
      <SelectTrigger id={id} className={className}><SelectValue /></SelectTrigger>
      <SelectContent>{opts.map((o) => <SelectItem key={o.value} value={o.value || EMPTY}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export const fmtDate = (s: string) => s ? new Date(s).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
/** Last view of a note as "3 日前" / "今日" / "未読" (ISO in, from the API's `views` table). */
export const fmtViewed = (iso: string | null | undefined): string => {
  if (!iso) return "未読";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "今日" : days === 1 ? "昨日" : days < 30 ? `${days} 日前` : days < 365 ? `${Math.floor(days / 30)} か月前` : `${Math.floor(days / 365)} 年前`;
};
/** Muted "閲覧: …" tag, used wherever a note row shows when it was last looked at. */
export const Viewed = ({ at }: { at: string | null | undefined }) => <span className="text-xs text-muted-foreground" title={at ? new Date(at).toLocaleString("ja-JP") : "まだ開いていない"}>閲覧 {fmtViewed(at)}</span>;
