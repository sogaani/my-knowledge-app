import { NavLink, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Notes from "./pages/Notes";
import Note from "./pages/Note";
import Inbox from "./pages/Inbox";
import Chat from "./pages/Chat";
import Suggestions from "./pages/Suggestions";
import Jobs from "./pages/Jobs";

const TYPES: [string, string][] = [
  ["book", "読書"], ["media", "映画・ドラマ"], ["subscription", "サブスク"], ["finance_account", "金融"],
  ["project", "プロジェクト"], ["learning", "学習"], ["review", "レビュー"], ["person", "人物"],
];

export default function App() {
  return (
    <div className="layout">
      <nav className="side">
        <h1>my-knowledge</h1>
        <NavLink to="/" end>ホーム</NavLink>
        <NavLink to="/inbox">投げ込み</NavLink>
        <NavLink to="/chat">チャット</NavLink>
        <NavLink to="/suggestions">おすすめ</NavLink>
        <NavLink to="/jobs">ジョブ</NavLink>
        <div className="group">ノート</div>
        {TYPES.map(([t, label]) => <NavLink key={t} to={`/notes/${t}`}>{label}</NavLink>)}
        <NavLink to="/search">検索</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/suggestions" element={<Suggestions />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/notes/:type" element={<Notes />} />
          <Route path="/search" element={<Notes />} />
          <Route path="/note/*" element={<Note />} />
        </Routes>
      </main>
    </div>
  );
}

export const typeLabel = (t: string) => TYPES.find(([k]) => k === t)?.[1] ?? t;
