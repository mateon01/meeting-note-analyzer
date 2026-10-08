import type { ChatMessageDto, ChatSessionDto, CompleteUploadRequest, CreateMeetingRequest, CreateMeetingResponse, MeetingDto, MeetingResultResponse, NotesDocument } from "@meeting-notes/shared";
import { useAuth } from "react-oidc-context";
import { useMemo } from "react";
import { useConfig } from "./use-config";
import { renewSession } from "./auth-renew";
import type { CompleteLectureUpload, CreateLectureRequest, CreateLectureResponse, LectureDocument, LectureDto, LectureResultLinks, LectureResultResponse } from "@meeting-notes/shared";
import type { CompleteInterviewUpload, CreateInterviewRequest, CreateInterviewResponse, InterviewDocument, InterviewDto, InterviewResult, InterviewResultLinks, InterviewSettings } from "@meeting-notes/shared";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function createApi(base: string, getToken: () => string | undefined, renew?: () => Promise<string | undefined>) {
  const send = (method: string, path: string, body: unknown, token: string | undefined) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  async function call<T>(method: string, path: string, body?: unknown, format: "json" | "text" = "json"): Promise<T> {
    let res = await send(method, path, body, getToken());
    if (res.status === 401 && renew) {
      // The ID token can expire while the app sits in the background; renew once with the refresh token and retry.
      const fresh = await renew().catch(() => undefined);
      if (fresh) res = await send(method, path, body, fresh);
    }
    if (res.status === 204) return undefined as T;
    if (res.ok && format === "text") return await res.text() as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`);
    return data as T;
  }
  return {
    createInterview: (input: CreateInterviewRequest) => call<CreateInterviewResponse>("POST", "/interviews", input),
    completeInterviewUpload: (id: string, input: CompleteInterviewUpload) => call<void>("POST", `/interviews/${encodeURIComponent(id)}/complete-upload`, input),
    startInterview: (id: string) => call<void>("POST", `/interviews/${encodeURIComponent(id)}/start`),
    retryInterview: (id: string) => call<void>("POST", `/interviews/${encodeURIComponent(id)}/retry`),
    updateInterviewSettings: (id: string, settings: InterviewSettings) => call<{ interview: InterviewDto }>("PATCH", `/interviews/${encodeURIComponent(id)}/settings`, settings),
    listInterviews: (cursor?: string) => call<{ items: InterviewDto[]; cursor: string | null }>("GET", `/interviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    interviewResult: async (id: string): Promise<InterviewResult> => {
      const links = await call<InterviewResultLinks>("GET", `/interviews/${encodeURIComponent(id)}/result`);
      let document: InterviewDocument | null = null;
      if (links.documentUrl) {
        const response = await fetch(links.documentUrl, { cache: "no-store" });
        if (!response.ok) throw new ApiError(response.status, "document_download", "인터뷰 노트를 불러오지 못했습니다. 다시 시도하세요.");
        document = await response.json() as InterviewDocument;
      }
      return { ...links, document };
    },
    downloadInterview: async (id: string): Promise<string> => {
      for (let attempt = 0; ; attempt++) {
        try { return await call<string>("GET", `/interviews/${encodeURIComponent(id)}/markdown`, undefined, "text"); }
        catch (error) {
          const transient = error instanceof TypeError || (error instanceof ApiError && (error.status === 429 || error.status >= 500));
          if (attempt || !transient) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    },
    deleteInterview: (id: string) => call<void>("DELETE", `/interviews/${encodeURIComponent(id)}`),
    createLecture: (input: CreateLectureRequest) => call<CreateLectureResponse>("POST", "/lectures", input),
    completeLectureUpload: (id: string, input: CompleteLectureUpload) => call<void>("POST", `/lectures/${encodeURIComponent(id)}/complete-upload`, input),
    startLecture: (id: string) => call<void>("POST", `/lectures/${encodeURIComponent(id)}/start`),
    retryLecture: (id: string) => call<void>("POST", `/lectures/${encodeURIComponent(id)}/retry`),
    listLectures: (cursor?: string) => call<{ items: LectureDto[]; cursor: string | null }>("GET", `/lectures${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    lectureResult: async (id: string): Promise<LectureResultResponse> => {
      const links = await call<LectureResultLinks>("GET", `/lectures/${encodeURIComponent(id)}/result`);
      let document: LectureDocument | null = null;
      if (links.documentUrl) {
        const response = await fetch(links.documentUrl);
        if (!response.ok) throw new ApiError(response.status, "document_download", "학습 자료를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
        document = await response.json() as LectureDocument;
      }
      return { ...links, document };
    },
    deleteLecture: (id: string) => call<void>("DELETE", `/lectures/${encodeURIComponent(id)}`),
    listLectureShares: (id: string) => call<{ items: import("@meeting-notes/shared").LectureShare[] }>("GET", `/lectures/${encodeURIComponent(id)}/shares`),
    createLectureShare: (id: string, emails: string[], expiresInDays: number) => call<{ share: import("@meeting-notes/shared").LectureShare }>("POST", `/lectures/${encodeURIComponent(id)}/shares`, { emails, expiresInDays }),
    revokeLectureShare: (id: string, shareId: string) => call<void>("DELETE", `/lectures/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`),
    me: () => call<{ sub: string; email: string | null; name: string | null }>("GET", "/me"),
    createMeeting: (input: CreateMeetingRequest) => call<CreateMeetingResponse>("POST", "/meetings", input),
    completeUpload: (id: string, body: CompleteUploadRequest) => call<void>("POST", `/meetings/${encodeURIComponent(id)}/complete-upload`, body),
    listMeetings: (cursor?: string) => call<{ items: MeetingDto[]; cursor: string | null }>("GET", `/meetings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    getMeeting: (id: string) => call<{ meeting: MeetingDto }>("GET", `/meetings/${encodeURIComponent(id)}`),
    getResult: (id: string) => call<MeetingResultResponse>("GET", `/meetings/${encodeURIComponent(id)}/result`),
    deleteMeeting: (id: string) => call<void>("DELETE", `/meetings/${encodeURIComponent(id)}`),
    retryMeeting: (id: string) => call<{ executionArn: string }>("POST", `/meetings/${encodeURIComponent(id)}/retry`),
    createMeetingBrief: (id: string) => call<{ executionArn: string }>("POST", `/meetings/${encodeURIComponent(id)}/brief`),
    updateMeeting: (id: string, body: { title: string }) => call<{ meeting: MeetingDto }>("PATCH", `/meetings/${encodeURIComponent(id)}`, body),
    renameSpeakers: (id: string, labels: Record<string, string>) => call<{ speakers: NotesDocument["speakers"] }>("PATCH", `/meetings/${encodeURIComponent(id)}/speakers`, { labels }),
    subscribePush: (sub: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }) => call<void>("PUT", "/push/subscription", sub),
    unsubscribePush: (endpoint: string) => call<void>("DELETE", "/push/subscription", { endpoint }),
    vapidPublicKey: () => call<{ publicKey: string }>("GET", "/push/vapid-public-key"),
    listChatSessions: () => call<{ items: ChatSessionDto[] }>("GET", "/chat/sessions"),
    createChatSession: (scope?: string | import("@meeting-notes/shared").CreateChatSessionRequest) => call<{ session: ChatSessionDto }>("POST", "/chat/sessions", typeof scope === "string" ? { meetingId: scope } : scope ?? {}),
    getChatMessages: (id: string) => call<{ session: ChatSessionDto; items: ChatMessageDto[] }>("GET", `/chat/sessions/${encodeURIComponent(id)}/messages`),
    deleteChatSession: (id: string) => call<void>("DELETE", `/chat/sessions/${encodeURIComponent(id)}`),
  };
}

export type Api = ReturnType<typeof createApi>;

export function useApi(): Api {
  const auth = useAuth();
  const cfg = useConfig();
  const token = auth.user?.id_token;
  const { signinSilent } = auth;
  return useMemo(() => createApi(cfg.apiBase, () => token, async () => (await renewSession(signinSilent))?.id_token), [cfg.apiBase, token, signinSilent]);
}
