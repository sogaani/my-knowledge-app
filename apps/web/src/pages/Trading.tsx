import { useEffect, useState } from "react";
import { api } from "../api";
import Md from "../components/Md";
import { Err } from "../components/ui";
import { disablePush, enablePush, pushState, type PushState } from "../push";

const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "この環境では通知不可（iPhone はホーム画面に追加してから）", disabled: "通知はサーバー未設定（VAPID 鍵）",
  denied: "通知がブラウザでブロックされています", off: "通知を有効化", on: "通知を解除",
};

/** 売買: renders 30_gold/38_trading.md (latest trade_plan sheet + recent sheets + portfolio snapshot). */
export default function Trading() {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const [push, setPush] = useState<PushState | null>(null);
  const load = () => api.gold("38_trading").then((g) => setMd(g.markdown.replace(/^<!--[\s\S]*?-->\n?/, ""))).catch(setErr);
  useEffect(() => { load(); pushState().then(setPush).catch(() => setPush("unsupported")); }, []);
  const run = async () => {
    setBusy(true); setMsg("");
    try { const j = await api.runJob("skill", { name: "trade-plan" }); setMsg(`ジョブ ${j.id.slice(0, 8)} を投入しました。終わると通知が届きます（数分）。`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const togglePush = async () => {
    try { setPush(push === "on" ? await disablePush() : await enablePush()); } catch (e) { setErr(e); }
  };
  const testPush = async () => {
    try { const r = await api.pushTest(); setMsg(`テスト通知: 送信 ${r.sent} / 失効 ${r.removed} / 失敗 ${r.failed}`); } catch (e) { setErr(e); }
  };
  const updated = md ? /（(\d{4}-\d{2}-\d{2}) 更新）/.exec(md)?.[1] : "";
  return (
    <>
      <h2>売買 <span className="muted small">{updated && `${updated} 更新`}</span></h2>
      <div className="toolbar">
        <button className="ghost" disabled={busy} onClick={run}>trade-plan を実行（Mac ワーカー）</button>
        <button className="ghost" onClick={load}>再読み込み</button>
        {push && <button className="ghost" disabled={push !== "on" && push !== "off"} onClick={togglePush}>{PUSH_LABEL[push]}</button>}
        {push === "on" && <button className="ghost small" onClick={testPush}>テスト通知</button>}
        {msg && <span className="small muted">{msg}</span>}
      </div>
      <Err e={err} />
      {md === null ? <p className="muted">読み込み中…</p> : <Md text={md.replace(/^# .*\n/, "")} basePath="30_gold/38_trading.md" />}
    </>
  );
}
