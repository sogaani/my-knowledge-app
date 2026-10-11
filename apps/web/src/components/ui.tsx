import { Link } from "react-router-dom";
import type { NoteSummary } from "../api";

export const Stars = ({ n }: { n: unknown }) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? <span className="stars">{"★".repeat(v)}{"☆".repeat(5 - v)}</span> : null;
};
export const Status = ({ s }: { s: string }) => <span className={`status-${s}`}>{s}</span>;
export const NoteLink = ({ n }: { n: NoteSummary | { path: string; title: string } }) => <Link to={`/note/${n.path}`}>{n.title}</Link>;
export const Err = ({ e }: { e: unknown }) => (e ? <p className="err">{String((e as Error).message ?? e)}</p> : null);
export const fmtDate = (s: string) => s ? new Date(s).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
