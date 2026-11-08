import { createSignal, createEffect, onMount, Show, onCleanup } from "solid-js";
import { exportBackup, importBackup } from "../storage";
import { getSettings, setSettings, applySettings } from "../settings";
import type { Theme } from "../settings";
import { navigate } from "../App";
import { getSyncState, subscribeSync, syncNow, setSyncAccount, type SyncState } from "../sync";

type Message = { kind: "success" | "error"; text: string };
type CloudUser = { id: string; email: string };

function syncStateLabel(state: SyncState): string {
  if (state.status === "syncing") return "同期中…";
  if (state.status === "error") return "エラー";
  if (state.pendingPush > 0) return "未送信の変更あり";
  return "アイドル";
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

export default function SettingsPage() {
  const initial = getSettings();
  const [fontSize, setFontSize] = createSignal(initial.fontSize);
  const [lineHeight, setLineHeight] = createSignal(initial.lineHeight);
  const [theme, setTheme] = createSignal<Theme>(initial.theme);
  const [verticalWriting, setVerticalWriting] = createSignal(initial.verticalWriting);
  const [message, setMessage] = createSignal<Message | null>(null);

  let settingsReady = false;
  createEffect(() => {
    const s = {
      fontSize: fontSize(),
      lineHeight: lineHeight(),
      theme: theme(),
      verticalWriting: verticalWriting(),
    };
    if (!settingsReady) {
      settingsReady = true;
      return;
    }
    setSettings(s);
    applySettings(s);
  });

  const handleBackup = () => {
    try {
      const json = exportBackup();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `netnoveleditor-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage({ kind: "success", text: "バックアップをダウンロードしました" });
    } catch (err) {
      setMessage({
        kind: "error",
        text: `バックアップに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleImport = (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    if (!confirm("現在のすべての作品が上書きされます。続行しますか？")) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = String(reader.result ?? "");
        const result = importBackup(json);
        setMessage({
          kind: "success",
          text: `${result.works}作品・${result.chapters}話をインポートしました。まもなく作品一覧へ移動します…`,
        });
        setTimeout(() => navigate(""), 1500);
      } catch (err) {
        setMessage({
          kind: "error",
          text: `インポートに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };
    reader.onerror = () => {
      setMessage({ kind: "error", text: "ファイルの読み込みに失敗しました" });
    };
    reader.readAsText(file);
  };

  const goHome = () => navigate("");

  const selectTheme = (next: Theme) => {
    setTheme(next);
  };

  const [cloudError, setCloudError] = createSignal<string | null>(null);
  const [cloudNotice, setCloudNotice] = createSignal<string | null>(null);
  const [cloudBusy, setCloudBusy] = createSignal(false);
  const [cloudLoading, setCloudLoading] = createSignal(true);
  const [cloudUser, setCloudUser] = createSignal<CloudUser | null>(null);

  const refreshCloudUser = async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) throw new Error("ログイン状態を確認できませんでした");
      const data = (await res.json().catch(() => ({}))) as { user?: CloudUser | null };
      const user = data.user ?? null;
      setCloudUser(user);
      setSyncAccount(user?.id ?? null);
    } catch {
      setCloudUser(null);
      setSyncAccount(null);
      setCloudError("ログイン状態を確認できませんでした。ページを再読み込みしてください。");
    } finally {
      setCloudLoading(false);
    }
  };

  const [syncState, setSyncState] = createSignal<SyncState>(getSyncState());
  const [syncMessage, setSyncMessage] = createSignal<Message | null>(null);
  let unsubscribeSync: (() => void) | undefined;

  const handleSync = async () => {
    setSyncMessage(null);
    const result = await syncNow();
    if (!result.ok) {
      setSyncMessage({ kind: "error", text: `同期に失敗しました: ${result.error}` });
      return;
    }
    const r = result.result;
    if (!r) {
      setSyncMessage({ kind: "success", text: "変更はありません" });
      return;
    }
    const pushed = r.pushedSyosetu + r.pushedChapters;
    const pulled = r.pulledSyosetu + r.pulledChapters;
    const serverWins = r.serverWinsSyosetu + r.serverWinsChapters;
    const parts: string[] = [];
    parts.push(r.uploadRequestSent ? "upload実行" : "upload対象なし");
    if (r.deleteRequestsSent > 0) parts.push(`削除送信${r.deleteRequestsSent}件`);
    if (r.downloadRequestSent) parts.push("download実行");
    if (pushed > 0) parts.push(`送信${pushed}件`);
    if (pulled > 0) parts.push(`受信${pulled}件`);
    if (serverWins > 0) parts.push(`競合${serverWins}件はサーバー側を採用`);
    setSyncMessage({
      kind: "success",
      text: parts.length > 0 ? `同期完了: ${parts.join(" / ")}` : "同期完了: 変更はありません",
    });
  };

  onMount(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get("auth_error");
    const errors: Record<string, string> = {
      configuration: "Googleログインのサーバー設定が未完了です。管理者にお問い合わせください。",
      invalid_state:
        "認証の有効期限が切れたか、不正なリクエストです。もう一度ログインしてください。",
      cancelled: "Googleログインをキャンセルしました。",
      unverified_email: "メールアドレスが確認済みのGoogleアカウントを使用してください。",
      failed: "Googleログインに失敗しました。もう一度お試しください。",
    };
    if (error) setCloudError(errors[error] ?? errors.failed);
    if (url.searchParams.get("auth_success") === "1") {
      setCloudNotice("Googleアカウントでログインしました。初めての方は会員登録も完了しています。");
    }
    if (url.searchParams.has("auth_error") || url.searchParams.has("auth_success")) {
      url.searchParams.delete("auth_error");
      url.searchParams.delete("auth_success");
      window.history.replaceState(null, "", url);
    }
    void refreshCloudUser();
    unsubscribeSync = subscribeSync((s) => setSyncState(s));
  });

  onCleanup(() => {
    unsubscribeSync?.();
  });

  const handleCloudLogin = () => {
    setCloudError(null);
    setCloudBusy(true);
    window.location.assign("/api/auth/google");
  };

  const handleCloudLogout = async () => {
    setCloudBusy(true);
    setCloudError(null);
    try {
      const res = await fetch("/api/auth/signout", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("サーバーでログアウトできませんでした");
      setCloudUser(null);
      setSyncAccount(null);
      setCloudNotice(null);
    } catch (err) {
      setCloudError(
        `ログアウトに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCloudBusy(false);
    }
  };

  return (
    <section>
      <nav class="breadcrumb">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            goHome();
          }}
        >
          ← 作品一覧
        </a>
      </nav>
      <h1>設定</h1>

      <h2>表示</h2>
      <div class="setting-row">
        <label for="font-size-input">
          フォントサイズ: <strong>{fontSize()}px</strong>
        </label>
        <input
          id="font-size-input"
          type="range"
          min="12"
          max="28"
          step="1"
          value={fontSize()}
          onInput={(e) => setFontSize(Number(e.currentTarget.value))}
        />
      </div>
      <div class="setting-row">
        <label for="line-height-input">
          行の高さ: <strong>{lineHeight().toFixed(1)}</strong>
        </label>
        <input
          id="line-height-input"
          type="range"
          min="1.2"
          max="2.4"
          step="0.1"
          value={lineHeight()}
          onInput={(e) => setLineHeight(Number(e.currentTarget.value))}
        />
      </div>
      <div class="setting-row">
        <label>
          <input
            type="checkbox"
            checked={verticalWriting()}
            onChange={(e) => setVerticalWriting(e.currentTarget.checked)}
          />
          縦書きモード
        </label>
      </div>

      <h2>テーマ</h2>
      <div class="theme-options" role="radiogroup" aria-label="テーマ">
        <label class={theme() === "light" ? "theme-option active" : "theme-option"}>
          <input
            type="radio"
            name="theme"
            value="light"
            checked={theme() === "light"}
            onChange={() => selectTheme("light")}
          />
          <span class="theme-preview light-preview">ライト</span>
        </label>
        <label class={theme() === "dark" ? "theme-option active" : "theme-option"}>
          <input
            type="radio"
            name="theme"
            value="dark"
            checked={theme() === "dark"}
            onChange={() => selectTheme("dark")}
          />
          <span class="theme-preview dark-preview">ダーク</span>
        </label>
        <label class={theme() === "sepia" ? "theme-option active" : "theme-option"}>
          <input
            type="radio"
            name="theme"
            value="sepia"
            checked={theme() === "sepia"}
            onChange={() => selectTheme("sepia")}
          />
          <span class="theme-preview sepia-preview">セピア</span>
        </label>
      </div>

      <h2>クラウド同期</h2>
      <p class="muted">
        Googleアカウントで登録・ログインすると、作品をクラウドにバックアップして複数端末で同期できます。
        初回ログイン時に会員登録が完了します。パスワードの設定は不要です。
      </p>
      <Show
        when={cloudUser()}
        fallback={
          <div class="cloud-login-form">
            <div class="cloud-login-actions">
              <button
                type="button"
                onClick={handleCloudLogin}
                disabled={cloudBusy() || cloudLoading()}
              >
                {cloudLoading()
                  ? "ログイン状態を確認中…"
                  : cloudBusy()
                    ? "Googleへ移動中…"
                    : "Googleで登録・ログイン"}
              </button>
            </div>
            <p class="muted">
              この端末の作品はログイン後に自動同期されます。共有端末ではご注意ください。
            </p>
          </div>
        }
      >
        <div class="cloud-status">
          <p>
            ログイン中: <strong>{(cloudUser() as CloudUser).email}</strong>
          </p>
          <button type="button" onClick={handleCloudLogout} disabled={cloudBusy()}>
            ログアウト
          </button>
        </div>
      </Show>
      <Show when={cloudError()}>
        <p class="error" role="alert">
          {cloudError()}
        </p>
      </Show>
      <Show when={cloudNotice()}>
        <p class="success" role="status">
          {cloudNotice()}
        </p>
      </Show>

      <h2>手動同期</h2>
      <p class="muted">
        起動時・画面移動時・画面復帰時・通信復旧時と、表示中は1分ごとに自動同期します。
        ここから手動でも同期できます。競合があった際はより新しい編集が優先されます。
      </p>
      <div class="sync-panel">
        <p>
          状態: <strong>{syncStateLabel(syncState())}</strong>
          <Show when={syncState().pendingPush > 0}>
            <span class="muted">（未送信 {syncState().pendingPush} 件）</span>
          </Show>
        </p>
        <p class="muted">
          <Show
            when={syncState().lastSyncAt}
            fallback={<span>まだ同期したことはありません。</span>}
          >
            最終同期: {formatDateTime(syncState().lastSyncAt!)}
          </Show>
        </p>
        <Show when={syncState().lastError}>
          <p class="error">前回の同期でエラー: {syncState().lastError}</p>
        </Show>
        <div class="sync-actions">
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncState().status === "syncing" || !cloudUser()}
            title={cloudUser() ? "今すぐクラウドと同期します" : "ログインが必要です"}
          >
            {syncState().status === "syncing" ? "同期中…" : "今すぐ同期"}
          </button>
        </div>
        <Show when={syncMessage()}>
          <p class={syncMessage()!.kind === "error" ? "error" : "success"}>{syncMessage()!.text}</p>
        </Show>
      </div>

      <h2>バックアップ&インポート</h2>
      <p class="muted">
        作品データを単一のJSONファイルにバックアップ・復元します。インポートを行うと現在のすべての作品が上書きされるのでご注意ください。
        復元した作品は新しい変更としてクラウドにも送信されます。クラウドだけにある作品は同期時に追加されます。
      </p>
      <div class="backup-actions">
        <button type="button" onClick={handleBackup}>
          バックアップをダウンロード
        </button>
        <label class="file-input-label">
          ファイルからインポート
          <input
            type="file"
            accept="application/json,.json"
            onChange={handleImport}
            disabled={syncState().status === "syncing"}
          />
        </label>
      </div>
      <Show when={message()}>
        <p class={message()!.kind === "error" ? "error" : "success"}>{message()!.text}</p>
      </Show>
    </section>
  );
}
