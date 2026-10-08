/** Chat (beta) contracts shared by the API, the streaming Lambda, the agent runtime (mirrored in Python) and the web app. */
export type ChatSourceType = "meeting" | "lecture" | "all";
export interface CreateChatSessionRequest { sourceType?: ChatSourceType; meetingId?: string; lectureId?: string }

export interface ChatSessionRecord {
  PK: `CHATSESSION#${string}`;
  SK: "META";
  GSI1PK: string; // USER#{sub}#CHAT
  GSI1SK: string; // updatedAt
  sessionId: string;
  owner: string;
  title: string;
  meetingId?: string;
  lectureId?: string;
  sourceType?: ChatSourceType;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview?: string;
}
export type ChatSessionDto = Omit<ChatSessionRecord, "PK" | "SK" | "GSI1PK" | "GSI1SK" | "owner">;

export interface ChatEvidence {
  id: string; // E1, E2 ...
  kind: "document" | "transcript" | "lecture";
  meetingId: string | null; // null for lecture evidence
  lectureId?: string | null;
  page?: number | null; // lecture section, when the passage carried its heading
  title: string | null;
  date: string | null;
  meetingType: string | null;
  snippet: string;
  score: number | null;
  startSec: number | null;
  segmentIds: string[];
  url: string;
}

export interface ChatStep {
  id: string;
  name: string;
  title: string;
  result?: string;
}

export interface ChatMessageDto {
  seq: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  evidence?: ChatEvidence[];
  steps?: ChatStep[];
  /** Tappable replies offered by a clarifying question (ask_user). */
  options?: string[];
}

export interface ChatTurnRequest {
  sessionId: string;
  message: string;
  meetingId?: string;
  language?: "ko" | "en";
}

/** Server-sent events emitted by the chat runtime, relayed verbatim by the streaming Lambda. */
export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_use"; id: string; name: string; title: string }
  | { type: "tool_result"; id: string; name: string; summary: string; isError: boolean }
  | { type: "evidence"; items: ChatEvidence[] }
  | { type: "clarify"; question: string; options: string[] }
  | { type: "done"; messageSeq: number; usage?: Record<string, unknown>; evidenceCount: number }
  | { type: "error"; message: string }
  | { type: "keepalive" };

export const chatKeys = {
  session: (sessionId: string) => ({ PK: `CHATSESSION#${sessionId}`, SK: "META" }),
  messagePrefix: "MSG#",
  userGsi: (sub: string) => `USER#${sub}#CHAT`,
} as const;
