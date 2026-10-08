import { createHash, createHmac, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AdminCreateUserCommand, AdminGetUserCommand, AdminInitiateAuthCommand, AdminRespondToAuthChallengeCommand, CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { ddb, env, getLecture, lectureTable, readJson, s3 } from "@meeting-notes/backend";
import { type GuestLectureResult, type LectureDocument } from "@meeting-notes/shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { HttpError, parseBody } from "../lib/http.js";
import { getShare, type ShareRecord } from "../routes/lecture-sharing.js";

const poolId = process.env["GUEST_USER_POOL_ID"] ?? "";
const clientId = process.env["GUEST_USER_POOL_CLIENT_ID"] ?? "";
const cognito = new CognitoIdentityProviderClient({});
const verifier = CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: "id" });
const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
// Cognito EMAIL_OTP uses eight characters; retain compatibility with six-character codes.
// Forward the complete code unchanged and let Cognito verify it.
const codeSchema = z.object({ challengeId: z.string().uuid(), code: z.string().trim().regex(/^[A-Za-z0-9]{6,8}$/) });
const epoch = () => Math.floor(Date.now() / 1000);
const key = (id: string) => ({ PK: `GUEST_CHALLENGE#${id}`, SK: "META" });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const reply = (statusCode: number, body: unknown, cookies?: string[]): APIGatewayProxyResultV2 => ({
  statusCode, headers: { "content-type": "application/json", "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
  body: JSON.stringify(body), ...(cookies ? { cookies } : {}),
});
let secret: Promise<string> | undefined;
async function secretHash(username: string) {
  secret ??= cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: clientId }))
    .then((r) => { if (!r.UserPoolClient?.ClientSecret) throw new Error("Guest client secret missing"); return r.UserPoolClient.ClientSecret; })
    .catch((error) => { secret = undefined; throw error; });
  return createHmac("sha256", await secret).update(username + clientId).digest("base64");
}
export function activeShare(share: ShareRecord | undefined, now = epoch()): ShareRecord {
  if (!share || share.revokedAt || !Number.isFinite(share.ttl) || share.ttl <= now) throw new HttpError(404, "공유가 만료되었거나 해제되었습니다", "share_unavailable");
  return share;
}
export function invited(share: ShareRecord, email: string) {
  return share.emails.includes(email.trim().toLowerCase());
}
export async function rateLimit(identifier: string, maximum: number, seconds = 600) {
  const bucket = Math.floor(epoch() / seconds);
  try {
    await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: { PK: `GUEST_RATE#${hash(identifier)}#${bucket}`, SK: "META" },
      UpdateExpression: "SET #ttl = :ttl ADD #count :one", ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" }, ExpressionAttributeValues: { ":ttl": (bucket + 2) * seconds, ":one": 1, ":max": maximum } }));
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") throw new HttpError(429, "요청이 많습니다. 잠시 후 다시 시도하세요", "rate_limited");
    throw error;
  }
}
async function guestUsername(email: string) {
  try { return (await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }))).Username!; }
  catch (error) { if ((error as Error).name !== "UserNotFoundException") throw error; }
  try {
    const result = await cognito.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: email, MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "false" }] }));
    return result.User!.Username!;
  } catch (error) {
    if ((error as Error).name !== "UsernameExistsException") throw error;
    return (await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }))).Username!;
  }
}
async function requestCode(event: APIGatewayProxyEventV2, shareId: string) {
  const { email } = parseBody(event, emailSchema);
  await rateLimit(`ip:${event.requestContext.http.sourceIp}`, 100, 3600);
  await rateLimit(`email:${shareId}:${email}`, 5);
  const share = activeShare(await getShare(shareId));
  const challengeId = randomUUID();
  // Same response for an uninvited address, without sending it a message.
  if (!invited(share, email)) return reply(202, { challengeId });
  const username = await guestUsername(email);
  const auth = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: poolId, ClientId: clientId, AuthFlow: "USER_AUTH",
    AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: "EMAIL_OTP", SECRET_HASH: await secretHash(username) } }));
  if (auth.ChallengeName !== "EMAIL_OTP" || !auth.Session) throw new Error("Expected email verification challenge");
  await ddb.send(new PutCommand({ TableName: lectureTable(), Item: { ...key(challengeId), shareId, email, username,
    session: auth.Session, attempts: 0, ttl: epoch() + 300 }, ConditionExpression: "attribute_not_exists(PK)" }));
  return reply(202, { challengeId });
}
interface Challenge { shareId: string; email: string; username: string; session: string; ttl: number; usedAt?: number }

/** Only call after signature, issuer, client and token-use verification.
 * A first OTP token can predate the provider's email_verified update. In that
 * case require the current, enabled Cognito user to confirm the SAME subject
 * and email; never mark an address verified ourselves.
 */
async function verifiedTokenEmail(claims: Awaited<ReturnType<typeof verifier.verify>>): Promise<string | null> {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
  if (claims.email !== undefined && !email) return null;
  const flag: unknown = claims.email_verified;
  if (email && (flag === true || flag === "true")) return email;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const username = typeof claims["cognito:username"] === "string" ? claims["cognito:username"] : claims.sub;
  try {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
    const attributes = Object.fromEntries((user.UserAttributes ?? []).map((a) => [a.Name, a.Value]));
    const providerEmail = attributes["email"]?.trim().toLowerCase();
    if (user.Enabled !== true || user.UserStatus !== "CONFIRMED" || attributes["sub"] !== claims.sub ||
        !providerEmail || (email && providerEmail !== email) || attributes["email_verified"] !== "true") return null;
    return providerEmail;
  } catch (error) {
    if ((error as Error).name === "UserNotFoundException") return null;
    throw error;
  }
}

async function verifyCode(event: APIGatewayProxyEventV2, shareId: string) {
  const { challengeId, code } = parseBody(event, codeSchema);
  const result = await ddb.send(new GetCommand({ TableName: lectureTable(), Key: key(challengeId), ConsistentRead: true }));
  const challenge = result.Item as Challenge | undefined;
  if (!challenge || challenge.shareId !== shareId || challenge.ttl <= epoch() || challenge.usedAt) throw new HttpError(400, "인증 코드가 만료되었거나 올바르지 않습니다", "invalid_code");
  const share = activeShare(await getShare(shareId));
  if (!invited(share, challenge.email)) throw new HttpError(403, "초대된 이메일로 인증해 주세요", "not_invited");
  try {
    await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: key(challengeId), UpdateExpression: "ADD attempts :one",
      ConditionExpression: "attribute_exists(PK) AND #ttl > :now AND attempts < :max AND attribute_not_exists(usedAt)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":now": epoch(), ":max": 5 } }));
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") throw new HttpError(400, "인증 코드를 다시 요청해 주세요", "invalid_code");
    throw error;
  }
  let token: string | undefined;
  try {
    const auth = await cognito.send(new AdminRespondToAuthChallengeCommand({ UserPoolId: poolId, ClientId: clientId, ChallengeName: "EMAIL_OTP",
      Session: challenge.session, ChallengeResponses: { USERNAME: challenge.username, EMAIL_OTP_CODE: code, SECRET_HASH: await secretHash(challenge.username) } }));
    token = auth.AuthenticationResult?.IdToken;
  } catch (error) {
    if (["CodeMismatchException", "ExpiredCodeException", "NotAuthorizedException"].includes((error as Error).name)) throw new HttpError(400, "인증 코드가 만료되었거나 올바르지 않습니다", "invalid_code");
    throw error;
  }
  if (!token) throw new HttpError(400, "인증을 완료하지 못했습니다", "invalid_code");
  const claims = await verifier.verify(token);
  const email = await verifiedTokenEmail(claims);
  if (!email || email !== challenge.email) {
    console.warn("guest email verification mismatch", { emailPresent: typeof claims.email === "string",
      claimVerificationType: typeof claims.email_verified, providerVerified: !!email, emailMatchesChallenge: email === challenge.email });
    throw new HttpError(403, "이메일 인증을 확인할 수 없습니다");
  }
  if (!invited(activeShare(await getShare(shareId)), challenge.email)) throw new HttpError(403, "공유 접근이 해제되었습니다");
  await ddb.send(new UpdateCommand({ TableName: lectureTable(), Key: key(challengeId), UpdateExpression: "SET usedAt = :now",
    ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(usedAt) AND #ttl > :now",
    ExpressionAttributeNames: { "#ttl": "ttl" }, ExpressionAttributeValues: { ":now": epoch() } }));
  return reply(200, { verified: true }, [`mna_guest=${token}; Path=/api/guest; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`]);
}
async function authorizedShare(event: APIGatewayProxyEventV2, shareId: string) {
  const cookie = (event.cookies ?? (event.headers["cookie"] ?? "").split(";")).map((c) => c.trim()).find((c) => c.startsWith("mna_guest="));
  if (!cookie) throw new HttpError(401, "초대된 이메일로 인증해 주세요", "guest_auth_required");
  let claims;
  try { claims = await verifier.verify(cookie.slice("mna_guest=".length)); }
  catch { throw new HttpError(401, "이메일 인증이 만료되었습니다. 다시 인증해 주세요", "guest_auth_required"); }
  const email = await verifiedTokenEmail(claims);
  if (!email) throw new HttpError(401, "이메일 인증이 필요합니다", "guest_auth_required");
  const share = activeShare(await getShare(shareId));
  if (!invited(share, email)) throw new HttpError(403, "이 강의에 초대된 이메일이 아닙니다", "not_invited");
  const lecture = await getLecture(share.lectureId);
  if (!lecture || lecture.owner !== share.owner || !lecture.documentKey) throw new HttpError(404, "공유된 강의를 찾을 수 없습니다");
  if (!lecture.documentKey.startsWith(`lecture-results/${share.lectureId}/`)) throw new Error("Invalid lecture result key");
  const document = await readJson<LectureDocument>(lecture.documentKey);
  if (!document) throw new HttpError(404, "공유된 강의를 찾을 수 없습니다");
  return { share, document };
}
export function sharedImages(document: LectureDocument) {
  return document.pages.flatMap((p) => p.sourceImages?.length
    ? p.sourceImages.map((image) => ({ page: p.page, sourcePage: image.page, key: image.imageKey }))
    : p.imageKey ? [{ page: p.page, sourcePage: p.deckPage ?? p.page, key: p.imageKey }] : []);
}
export function publicDocument(document: LectureDocument): LectureDocument {
  const { usage, customPrompt, ...view } = document;
  return { ...view, pages: document.pages.map((p) => ({ ...p, imageKey: "", sourceImages: undefined })) };
}
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    if (event.headers["origin"] && event.headers["origin"] !== process.env["UPLOAD_BASE_URL"]) throw new HttpError(403, "허용되지 않은 요청입니다");
    if (event.routeKey === "POST /api/guest/logout") return reply(200, {}, ["mna_guest=; Path=/api/guest; Max-Age=0; HttpOnly; Secure; SameSite=Lax"]);
    const shareId = event.pathParameters?.["shareId"];
    if (!z.string().uuid().safeParse(shareId).success) throw new HttpError(404, "공유 링크를 찾을 수 없습니다");
    if (event.routeKey === "POST /api/guest/lectures/{shareId}/request-code") return await requestCode(event, shareId!);
    if (event.routeKey === "POST /api/guest/lectures/{shareId}/verify-code") return await verifyCode(event, shareId!);
    const { share, document } = await authorizedShare(event, shareId!);
    const images = sharedImages(document);
    if (event.routeKey === "GET /api/guest/lectures/{shareId}/images/{imageId}") {
      const index = Number(event.pathParameters?.["imageId"]) - 1;
      const image = Number.isInteger(index) && index >= 0 ? images[index] : undefined;
      if (!image || !image.key.startsWith(`lecture-results/${share.lectureId}/`)) throw new HttpError(404, "장표를 찾을 수 없습니다");
      const obj = await s3.send(new GetObjectCommand({ Bucket: env.dataBucket, Key: image.key }));
      if (!obj.Body || (obj.ContentLength ?? 0) > 4 * 1024 ** 2) throw new HttpError(413, "장표 이미지가 너무 큽니다");
      return { statusCode: 200, headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
        isBase64Encoded: true, body: Buffer.from(await obj.Body.transformToByteArray()).toString("base64") };
    }
    if (event.routeKey !== "GET /api/guest/lectures/{shareId}") throw new HttpError(404, "not found");
    const result: GuestLectureResult = { document: publicDocument(document), expiresAt: share.expiresAt,
      images: images.map((image, i) => ({ page: image.page, sourcePage: image.sourcePage, url: `/api/guest/lectures/${share.shareId}/images/${i + 1}` })) };
    return reply(200, result);
  } catch (error) {
    if (error instanceof HttpError) return reply(error.status, { error: error.code, message: error.message });
    if (["TooManyRequestsException", "LimitExceededException"].includes((error as Error).name)) return reply(429, { error: "rate_limited", message: "인증 요청이 많습니다. 잠시 후 다시 시도하세요." });
    if ((error as Error).name === "ConditionalCheckFailedException") return reply(400, { error: "invalid_code", message: "인증 코드를 다시 요청해 주세요." });
    console.error("guest lecture request failed", { route: event.routeKey, name: (error as Error).name });
    return reply(500, { error: "guest_error", message: "공유 강의 요청을 처리하지 못했습니다. 다시 시도하세요." });
  }
};
