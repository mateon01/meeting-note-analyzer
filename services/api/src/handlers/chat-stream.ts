import { Writable } from "node:stream";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { ChatStreamEvent, ChatTurnRequest } from "@meeting-notes/shared";
import { getOwnedChatSession } from "@meeting-notes/backend";

/** Lambda response-streaming globals (provided by the Node runtime, not by @types/aws-lambda). */
declare const awslambda: {
  streamifyResponse: (handler: (event: FunctionUrlEvent, responseStream: Writable) => Promise<void>) => unknown;
  HttpResponseStream: { from: (stream: Writable, metadata: { statusCode: number; headers: Record<string, string> }) => Writable };
};

interface FunctionUrlEvent {
  requestContext: { http: { method: string } };
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

const region = process.env["AWS_REGION"] ?? "us-east-1";
const agentcore = new BedrockAgentCoreClient({ region });
const verifier = CognitoJwtVerifier.create({ userPoolId: process.env["USER_POOL_ID"] ?? "", tokenUse: "id", clientId: process.env["USER_POOL_CLIENT_ID"] ?? "" });
const runtimeArn = process.env["CHAT_RUNTIME_ARN"] ?? "";
const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" };

const sse = (ev: ChatStreamEvent) => `data: ${JSON.stringify(ev)}\n\n`;

function parseBody(event: FunctionUrlEvent): ChatTurnRequest {
  const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "");
  const body = JSON.parse(raw || "{}") as Partial<ChatTurnRequest>;
  if (typeof body.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(body.sessionId)) throw new Error("sessionId");
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 4000) throw new Error("message");
  const out: ChatTurnRequest = { sessionId: body.sessionId, message: body.message.trim() };
  if (typeof body.meetingId === "string" && body.meetingId) out.meetingId = body.meetingId;
  if (body.language === "en" || body.language === "ko") out.language = body.language;
  return out;
}

async function endWithError(responseStream: Writable, status: number, message: string): Promise<void> {
  const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: status, headers: SSE_HEADERS });
  out.write(sse({ type: "error", message }));
  out.end();
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  if (event.requestContext.http.method !== "POST") return endWithError(responseStream, 405, "method not allowed");
  // Behind CloudFront OAC the Authorization header carries CloudFront's SigV4 signature, so the app token rides in x-mna-token.
  const auth = event.headers["authorization"] ?? event.headers["Authorization"] ?? "";
  const token = event.headers["x-mna-token"] ?? (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  let sub: string;
  try {
    const claims = await verifier.verify(token);
    sub = claims.sub;
  } catch {
    return endWithError(responseStream, 401, "unauthorized");
  }
  let req: ChatTurnRequest;
  try {
    req = parseBody(event);
  } catch (err) {
    return endWithError(responseStream, 400, `invalid ${(err as Error).message}`);
  }
  // The runtime re-checks ownership, but rejecting foreign session ids here keeps them from ever reaching it.
  const session = await getOwnedChatSession(sub, req.sessionId);
  if (!session) return endWithError(responseStream, 404, "chat session not found");
  if (req.meetingId && req.meetingId !== session.meetingId) return endWithError(responseStream, 400, "대상을 바꾸려면 새 대화를 시작하세요");

  const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: SSE_HEADERS });
  const payload = { sub, sessionId: req.sessionId, message: req.message, meetingId: session.meetingId, lectureId: session.lectureId,
    sourceType: session.sourceType ?? (session.meetingId ? "meeting" : "all"), language: req.language ?? "ko" };
  try {
    const res = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn,
        // Keep stored conversation history, but do not reuse a container running
        // old tool definitions after a runtime deployment.
        runtimeSessionId: `chat-${req.sessionId}-v${process.env["CHAT_RUNTIME_VERSION"] ?? "1"}`,
        runtimeUserId: sub,
        contentType: "application/json",
        accept: "text/event-stream",
        payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    const body = res.response;
    if (!body) throw new Error("empty runtime response");
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  } catch (err) {
    console.error("chat stream failed", { sessionId: req.sessionId, err: String(err) });
    out.write(sse({ type: "error", message: "챗봇 호출에 실패했습니다. 잠시 후 다시 시도해 주세요." }));
  } finally {
    out.end();
  }
});
