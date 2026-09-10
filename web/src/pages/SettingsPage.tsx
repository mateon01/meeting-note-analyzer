import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import { useApi } from "../lib/api";
import { useConfig } from "../lib/use-config";
import { navigateTo } from "../lib/navigation";
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported } from "../lib/push";
import { safeAreaInsets, samples, syncAppHeight } from "../lib/viewport";
import { IconBell, IconHome, IconLogOut, IconShare } from "../components/icons";
import { Avatar, Button, Card, InlineError, Page, SectionLabel, Toggle } from "../components/ui";

export function SettingsPage() {
  const auth = useAuth();
  const api = useApi();
  const cfg = useConfig();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [diag, setDiag] = useState(false);
  const standalone = isStandalone();
  const email = auth.user?.profile.email ?? auth.user?.profile.sub ?? "";
  const name = (auth.user?.profile.name as string | undefined) ?? email;

  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(!!s));
  }, []);

  async function toggle(next: boolean) {
    setMsg(null);
    setErr(null);
    try {
      if (next) {
        await enablePush(api);
        setSubscribed(true);
        setMsg("알림이 켜졌습니다. 분석이 끝나면 알려 드립니다.");
      } else {
        await disablePush(api);
        setSubscribed(false);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function logout() {
    // Revoke the 30-day refresh token first: clearing the device alone left it usable by anyone holding a copy.
    await auth.revokeTokens(["refresh_token"]).catch((err: unknown) => console.warn("refresh token revocation failed", String(err)));
    await auth.removeUser();
    navigateTo(`${cfg.cognitoDomain}/logout?client_id=${encodeURIComponent(cfg.cognitoClientId)}&logout_uri=${encodeURIComponent(`${window.location.origin}/`)}`);
  }

  return (
    <Page title="설정">
      <SectionLabel>계정</SectionLabel>
      <Card className="mt-2 p-4 flex items-center gap-3">
        <Avatar name={name} size={40} />
        <div className="min-w-0">
          <p className="font-semibold truncate">{name}</p>
          {name !== email && <p className="text-[12px] text-ink-3 truncate">{email}</p>}
        </div>
      </Card>

      <div className="mt-6"><SectionLabel>알림</SectionLabel></div>
      <Card className="mt-2 p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><IconBell size={20} /></span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold">완료 알림</p>
            <p className="text-[12px] text-ink-3">분석이 끝나면 푸시로 알려 드립니다.</p>
          </div>
          <Toggle checked={!!subscribed} disabled={subscribed === null || !pushSupported()} onChange={(v) => void toggle(v)} />
        </div>
        {!pushSupported() && isIos() && !standalone && <p className="mt-3 text-[12px] text-warning leading-relaxed">iPhone에서는 홈 화면에 추가한 앱에서만 알림을 켤 수 있습니다 (iOS 16.4 이상).</p>}
        {!pushSupported() && !isIos() && <p className="mt-3 text-[12px] text-ink-3">이 브라우저는 푸시 알림을 지원하지 않습니다.</p>}
        {msg && <p className="mt-3 text-[12px] text-success">{msg}</p>}
        {err && <InlineError>{err}</InlineError>}
      </Card>

      {isIos() && !standalone && (
        <>
          <div className="mt-6"><SectionLabel>홈 화면에 추가</SectionLabel></div>
          <Card className="mt-2 p-4">
            <ol className="space-y-3 text-[13.5px]">
              <li className="flex items-center gap-3"><span className="grid h-7 w-7 place-items-center rounded-lg bg-surface-3 text-ink-2"><IconShare size={16} /></span>Safari 하단의 공유 버튼을 누릅니다.</li>
              <li className="flex items-center gap-3"><span className="grid h-7 w-7 place-items-center rounded-lg bg-surface-3 text-ink-2"><IconHome size={16} /></span>“홈 화면에 추가”를 선택합니다.</li>
              <li className="flex items-center gap-3"><span className="grid h-7 w-7 place-items-center rounded-lg bg-surface-3 text-ink-2 text-[12px] font-bold">3</span>홈 화면의 ‘회의록’ 아이콘으로 실행하고 알림을 켭니다.</li>
            </ol>
          </Card>
        </>
      )}

      <Button variant="secondary" full className="mt-6" icon={<IconLogOut size={18} />} onClick={() => void logout()}>로그아웃</Button>

      <button className="tap mt-6 w-full text-center text-[12px] text-ink-3" onClick={() => { syncAppHeight("diag"); setDiag((v) => !v); }}>진단 정보 {diag ? "닫기" : "보기"}</button>
      {diag && <Diagnostics />}
      <p className="mt-8 text-center text-[11px] text-ink-3">Meeting Notes v0.2</p>
    </Page>
  );
}

/** Viewport measurements for debugging layout on real devices; screenshot this when the tab bar is misplaced. */
function Diagnostics() {
  const insets = safeAreaInsets();
  const bundle = Array.from(document.scripts).map((s) => s.src).find((s) => s.includes("/assets/index-"))?.split("/").pop() ?? "?";
  const latest = samples[samples.length - 1];
  return (
    <Card className="mt-3 p-4 text-[11px] text-ink-2 font-mono break-all">
      <p>bundle {bundle}</p>
      <p>standalone {String(isStandalone())} / ios {String(isIos())}</p>
      <p>screen {window.screen.width}x{window.screen.height} dpr {window.devicePixelRatio}</p>
      <p>safe-area top {insets.top} bottom {insets.bottom}</p>
      <p>now inner {window.innerHeight} visual {window.visualViewport ? Math.round(window.visualViewport.height) : "-"} scrollY {Math.round(window.scrollY)} appHeight {latest?.appHeight}</p>
      <p className="mt-2 text-ink-3">samples (t ms, source, inner, visual, offsetTop, scrollY, mainTop, shell, navBottom)</p>
      {samples.map((s, i) => (
        <p key={i}>{s.t} {s.source} {s.innerHeight} {s.visualHeight ?? "-"} {s.visualOffsetTop ?? "-"} {s.scrollY} {s.mainScrollTop ?? "-"} {s.shellHeight ?? "-"} {s.navBottom ?? "-"}</p>
      ))}
      <p className="mt-2">{navigator.userAgent}</p>
    </Card>
  );
}
