import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { routeFor } from "@/components/Md";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import Home from "./pages/Home";
import Notes from "./pages/Notes";
import Note from "./pages/Note";
import Inbox from "./pages/Inbox";
import Chat from "./pages/Chat";
import Suggestions from "./pages/Suggestions";
import Trading from "./pages/Trading";
import Jobs from "./pages/Jobs";
import Gold from "./pages/Gold";

const TYPES: [string, string][] = [
  ["book", "読書"], ["media", "映画・ドラマ"], ["subscription", "サブスク"], ["finance_account", "金融"],
  ["portfolio", "保有資産"], ["trade_plan", "売買シート"], ["stock", "銘柄"], ["theme", "投資テーマ"],
  ["project", "プロジェクト"], ["learning", "学習"], ["review", "レビュー"], ["person", "人物"],
];

const Item = ({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) => (
  <NavLink
    to={to}
    end={end}
    className={({ isActive }) => cn(
      "block rounded-md px-2.5 py-1.5 text-sm text-foreground no-underline transition-colors hover:bg-muted hover:no-underline",
      isActive && "bg-muted font-medium",
    )}
  >
    {children}
  </NavLink>
);

export default function App() {
  return (
    <div className="grid min-h-screen grid-rows-[auto_1fr] md:grid-cols-[220px_1fr] md:grid-rows-none">
      <nav className="flex flex-wrap content-start items-start gap-1 border-b px-3 py-2.5 md:sticky md:top-0 md:block md:h-screen md:space-y-0.5 md:overflow-auto md:border-r md:border-b-0 md:px-3.5 md:py-5">
        <h1 className="mb-1.5 w-full px-2.5 text-[15px] font-semibold tracking-wide md:mb-4">my-knowledge</h1>
        <Item to="/" end>ホーム</Item>
        <Item to="/inbox">投げ込み</Item>
        <Item to="/chat">チャット</Item>
        <Item to="/suggestions">おすすめ</Item>
        <Item to="/trading">売買</Item>
        <Item to="/gold/300_market">市場メモ</Item>
        <Item to="/gold/390_daily">ライフログ</Item>
        <Item to="/gold/391_trends">トレンド</Item>
        <Item to="/gold/392_upcoming">これからの予定</Item>
        <Item to="/jobs">ジョブ</Item>
        <div className="hidden px-2.5 pt-3.5 text-[11px] text-muted-foreground uppercase md:block">ノート</div>
        {TYPES.map(([t, label]) => <Item key={t} to={`/notes/${t}`}>{label}</Item>)}
        <Item to="/search">検索</Item>
      </nav>
      <main className="min-w-0 max-w-[1100px] p-4 md:px-8 md:py-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/suggestions" element={<Suggestions />} />
          <Route path="/trading" element={<Trading />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/notes/:type" element={<Notes />} />
          <Route path="/search" element={<Notes />} />
          <Route path="/gold/*" element={<Gold />} />
          <Route path="/note/*" element={<NoteOrGold />} />
        </Routes>
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

/** Old links / bookmarks to /note/300_gold/… go to the Gold view (Gold pages are not notes). */
function NoteOrGold() {
  const path = decodeURIComponent(useLocation().pathname.replace(/^\/note\//, ""));
  return path.startsWith("300_gold/") ? <Navigate to={routeFor(path)} replace /> : <Note />;
}

export const typeLabel = (t: string) => TYPES.find(([k]) => k === t)?.[1] ?? t;
