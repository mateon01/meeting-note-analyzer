import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "react-oidc-context";
import { LoginPage } from "./pages/LoginPage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { UploadPage } from "./pages/UploadPage";
import { MeetingPage } from "./pages/MeetingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ChatListPage } from "./pages/ChatListPage";
import { ChatPage } from "./pages/ChatPage";
import { LecturesPage } from "./pages/LecturesPage";
import { InterviewsPage } from "./pages/InterviewsPage";
// KaTeX ships with the lecture page only; keep it out of the initial bundle.
const LecturePage = lazy(() => import("./pages/LecturePage").then((m) => ({ default: m.LecturePage })));
const InterviewPage = lazy(() => import("./pages/InterviewPage").then((m) => ({ default: m.InterviewPage })));
const GuestLecturePage = lazy(() => import("./pages/GuestLecturePage").then((m) => ({ default: m.GuestLecturePage })));
import { TabBar } from "./components/TabBar";
import { Spinner } from "./components/icons";
import { renewSession } from "./lib/auth-renew";

/**
 * App shell: a fixed-height flex column whose <main> scrolls internally and whose tab bar is a normal flex child.
 * iOS home-screen (standalone) web apps mis-place `position: fixed; bottom: 0` elements at the top on first launch,
 * so the tab bar must not rely on fixed positioning.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main className="flex-1 min-h-0 overflow-y-auto safe-top">
        <div className="mx-auto w-full max-w-xl pb-6">{children}</div>
      </main>
      <TabBar />
    </div>
  );
}

export function App() {
  const auth = useAuth();
  const location = useLocation();
  // A session restored from storage may hold an ID token that expired while the app was closed. oidc-client-ts only
  // renews on its "expiring" timer, which never fires for a token that is already expired, so renew it here with the
  // refresh token before deciding between the app and the login page.
  const stale = !auth.isLoading && !auth.isAuthenticated && !!auth.user?.refresh_token;
  const [renewal, setRenewal] = useState<"idle" | "running" | "done" | "failed">("idle");
  const hadSession = useRef(false);
  if (auth.isAuthenticated) hadSession.current = true;
  else if (!auth.user && !auth.isLoading) hadSession.current = false;
  useEffect(() => {
    if (auth.isAuthenticated) { if (renewal !== "idle") setRenewal("idle"); return; }
    if (!stale || renewal !== "idle") return;
    setRenewal("running");
    void renewSession(auth.signinSilent).then((user) => setRenewal(user ? "done" : "failed"), () => setRenewal("failed"));
  }, [auth, stale, renewal]);
  if (location.pathname.startsWith("/shared/lectures/")) {
    return <Routes><Route path="/shared/lectures/:shareId" element={<Suspense fallback={<div className="grid min-h-dvh place-items-center"><Spinner /></div>}><GuestLecturePage /></Suspense>} /></Routes>;
  }
  const restoring = stale && (renewal === "idle" || renewal === "running");
  // AuthProvider marks signinSilent as loading/navigation too. Keep the authenticated
  // component tree mounted during this background work so drafts, uploads and audio survive.
  const backgroundRenewal = hadSession.current && !!auth.user && (auth.activeNavigator === "signinSilent" || restoring);
  if (!backgroundRenewal && (auth.isLoading || auth.activeNavigator || restoring)) {
    return (
      <div className="min-h-dvh grid place-items-center text-ink-3">
        <div className="flex flex-col items-center gap-3"><Spinner size={24} className="text-accent" /><p className="text-sm">로그인 확인 중</p></div>
      </div>
    );
  }
  if (!auth.isAuthenticated && !backgroundRenewal) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage error={auth.error?.message} from={location.pathname} />} />
      </Routes>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<MeetingsPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/lectures" element={<LecturesPage />} />
        <Route path="/lectures/new" element={<Navigate to="/upload?kind=lecture" replace />} />
        <Route path="/lectures/:id" element={<Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}><LecturePage /></Suspense>} />
        <Route path="/interviews" element={<InterviewsPage />} />
        <Route path="/interviews/new" element={<Navigate to="/upload?kind=interview" replace />} />
        <Route path="/interviews/:id" element={<Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}><InterviewPage /></Suspense>} />
        <Route path="/meetings/:id" element={<MeetingPage />} />
        <Route path="/chat" element={<ChatListPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/callback" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
