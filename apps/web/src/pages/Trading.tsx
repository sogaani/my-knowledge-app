import { useEffect, useState } from "react";
import { BellIcon, BellOffIcon, PlayIcon, RefreshCwIcon, SendIcon } from "lucide-react";
import { api } from "@/api";
import Md from "@/components/Md";
import { Err, Loading, PageTitle, Toolbar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/useAction";
import { disablePush, enablePush, pushState, type PushState } from "@/push";

const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "この環境では通知不可（iPhone はホーム画面に追加してから）", disabled: "通知はサーバー未設定（VAPID 鍵）",
  denied: "通知がブラウザでブロックされています", off: "通知を有効化", on: "通知を解除",
};

/** 売買: renders 300_gold/308_trading.md (latest trade_plan sheet + recent sheets + portfolio snapshot). */
export default function Trading() {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const fetchMd = () => api.gold("308_trading").then((g) => setMd(g.markdown.replace(/^<!--[\s\S]*?-->\n?/, "")));
  useEffect(() => { fetchMd().catch(setErr); pushState().then(setPush).catch(() => setPush("unsupported")); }, []);
  const reload = useAction(async () => { await fetchMd(); setErr(null); });
  const run = useAction(() => api.runJob("skill", { name: "trade-plan" }), { success: (j) => `ジョブ ${j.id.slice(0, 8)} を投入しました。終わると通知が届きます（数分）` });
  const togglePush = useAction(async () => {
    const next = push === "on" ? await disablePush() : await enablePush();
    setPush(next);
    return next;
  }, { success: (s) => (s === "on" ? "通知を有効にしました" : s === "off" ? "通知を解除しました" : PUSH_LABEL[s]) });
  const testPush = useAction(() => api.pushTest(), { success: (r) => `テスト通知: 送信 ${r.sent} / 失効 ${r.removed} / 失敗 ${r.failed}` });
  const updated = md ? /（(\d{4}-\d{2}-\d{2}) 更新）/.exec(md)?.[1] : "";
  return (
    <>
      <PageTitle sub={updated && `${updated} 更新`}>売買</PageTitle>
      <Toolbar>
        <Button variant="outline" loading={run.pending} onClick={() => run.run()}>{!run.pending && <PlayIcon data-icon="inline-start" />}trade-plan を実行（Mac ワーカー）</Button>
        <Button variant="outline" loading={reload.pending} onClick={() => reload.run()}>{!reload.pending && <RefreshCwIcon data-icon="inline-start" />}再読み込み</Button>
        {push && (
          <Button variant="outline" disabled={push !== "on" && push !== "off"} loading={togglePush.pending} onClick={() => togglePush.run()}>
            {!togglePush.pending && (push === "on" ? <BellOffIcon data-icon="inline-start" /> : <BellIcon data-icon="inline-start" />)}{PUSH_LABEL[push]}
          </Button>
        )}
        {push === "on" && <Button variant="ghost" size="sm" loading={testPush.pending} onClick={() => testPush.run()}>{!testPush.pending && <SendIcon data-icon="inline-start" />}テスト通知</Button>}
      </Toolbar>
      <Err e={err} />
      {md === null ? (!err && <Loading rows={8} />) : <Md text={md.replace(/^# .*\n/, "")} basePath="300_gold/308_trading.md" />}
    </>
  );
}
