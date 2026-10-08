import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createChatSession, deleteChatSession, deleteChatSessionMemory, getOwnedChatSession, listChatMessages, listChatSessions } from "@meeting-notes/backend";
import type { ChatMessageDto, ChatSessionDto } from "@meeting-notes/shared";
import { apiEnv } from "../lib/env.js";
import { HttpError, type Caller } from "../lib/http.js";
import { requireOwnedMeeting } from "./meetings.js";
import { ownedLecture } from "./lectures.js";

export const createChatSessionSchema = z.object({
  sourceType: z.enum(["meeting", "lecture", "all"]).optional(),
  meetingId: z.string().min(1).max(128).optional(),
  lectureId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if ((value.meetingId && value.lectureId) || (value.sourceType === "lecture" && value.meetingId) || (value.sourceType === "meeting" && value.lectureId) ||
      (value.sourceType === "all" && (value.meetingId || value.lectureId))) ctx.addIssue({ code: "custom", message: "대화할 자료 종류와 대상을 확인하세요" });
});

export async function createSession(caller: Caller, input: z.infer<typeof createChatSessionSchema>): Promise<{ session: ChatSessionDto }> {
  if (input.meetingId) await requireOwnedMeeting(caller, input.meetingId); // a foreign meeting id must not become a session scope
  if (input.lectureId) await ownedLecture(caller, input.lectureId);
  const scope = { sourceType: input.sourceType ?? (input.lectureId ? "lecture" : "meeting"), ...(input.lectureId ? { lectureId: input.lectureId } : {}) } as const;
  return { session: await createChatSession(caller.sub, randomUUID(), input.meetingId, scope) };
}

export async function listSessions(caller: Caller): Promise<{ items: ChatSessionDto[] }> {
  return { items: await listChatSessions(caller.sub) };
}

export async function requireOwnedSession(caller: Caller, sessionId: string): Promise<ChatSessionDto> {
  const s = await getOwnedChatSession(caller.sub, sessionId);
  if (!s) throw new HttpError(404, "chat session not found", "not_found");
  return s;
}

export async function getMessages(caller: Caller, sessionId: string): Promise<{ session: ChatSessionDto; items: ChatMessageDto[] }> {
  const session = await requireOwnedSession(caller, sessionId);
  return { session, items: await listChatMessages(sessionId) };
}

export async function removeSession(caller: Caller, sessionId: string): Promise<void> {
  await requireOwnedSession(caller, sessionId);
  // Memory first, like meetings: if it fails the session stays visible and can be deleted again.
  if (apiEnv.chatMemoryId) await deleteChatSessionMemory(apiEnv.chatMemoryId, caller.sub, sessionId);
  await deleteChatSession(sessionId);
}
