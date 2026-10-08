import { beforeEach, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
const m = vi.hoisted(() => ({ ddb: vi.fn(), cognito: vi.fn(), verify: vi.fn(), share: vi.fn(), lecture: vi.fn(), read: vi.fn(), s3: vi.fn() }));
vi.mock("@meeting-notes/backend", () => ({ ddb: { send: m.ddb }, lectureTable: () => "lectures", env: { dataBucket: "bucket" },
  getLecture: m.lecture, readJson: m.read, s3: { send: m.s3 } }));
vi.mock("../src/routes/lecture-sharing.js", () => ({ getShare: m.share }));
vi.mock("aws-jwt-verify", () => ({ CognitoJwtVerifier: { create: () => ({ verify: m.verify }) } }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-cognito-identity-provider")>(), CognitoIdentityProviderClient: class { send = m.cognito; },
}));
import { handler, activeShare, invited } from "../src/handlers/guest-lectures.js";
const shareId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-abcdefabcdef";
const guest = "guest@example.com";
const share = () => ({ PK: `LECTURE_SHARE#${shareId}`, SK: "META" as const, GSI1PK: "shares", GSI1SK: "now", shareId,
  lectureId: "lecture-1", owner: "owner", emails: [guest], createdAt: "2026-01-01", expiresAt: "2099-01-01", ttl: 4070908800 });
const challenge = () => ({ shareId, email: guest, username: "canonical-user", session: "synthetic-session", ttl: 4070908800 });
function event(routeKey: string, body?: unknown, authenticated = false): APIGatewayProxyEventV2 {
  return { version: "2.0", routeKey, rawPath: "", rawQueryString: "", headers: {}, isBase64Encoded: false,
    requestContext: { accountId: "test", apiId: "api", domainName: "example.invalid", domainPrefix: "api", requestId: "request",
      routeKey, stage: "$default", time: "now", timeEpoch: 0,
      http: { sourceIp: "192.0.2.1", method: "POST", path: "/", protocol: "HTTP/1.1", userAgent: "test" } }, pathParameters: { shareId },
    ...(body ? { body: JSON.stringify(body) } : {}), ...(authenticated ? { cookies: ["mna_guest=synthetic-token"] } : {}) };
}
const status = (response: Awaited<ReturnType<typeof handler>>) => typeof response === "object" ? response.statusCode : undefined;
beforeEach(() => {
  vi.clearAllMocks();
  m.share.mockResolvedValue(share());
  m.ddb.mockResolvedValue({});
  m.verify.mockResolvedValue({ email: guest, email_verified: true });
  m.lecture.mockResolvedValue({ owner: "owner", documentKey: "lecture-results/lecture-1/runs/current/document.json" });
  m.read.mockResolvedValue({ version: 1, lectureId: "lecture-1", title: "Class", customPrompt: "owner preference", usage: { calls: 9 },
    pages: [{ page: 1, sourcePages: [38], imageKey: "lecture-results/lecture-1/runs/current/source-slides/38.png",
      sourceImages: [{ page: 38, imageKey: "lecture-results/lecture-1/runs/current/source-slides/38.png" }] }] });
  m.cognito.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case "AdminGetUserCommand": return { Username: "canonical-user" };
      case "DescribeUserPoolClientCommand": return { UserPoolClient: { ClientSecret: "synthetic-test-secret" } };
      case "AdminInitiateAuthCommand": return { ChallengeName: "EMAIL_OTP", Session: "synthetic-session" };
      case "AdminRespondToAuthChallengeCommand": return { AuthenticationResult: { IdToken: "synthetic-token" } };
      default: throw new Error("Unexpected Cognito call");
    }
  });
});

it("does not send a code to an uninvited address", async () => {
  const response = await handler(event("POST /api/guest/lectures/{shareId}/request-code", { email: "other@example.com" }));
  expect(status(response)).toBe(202);
  expect(m.cognito).not.toHaveBeenCalled();
});

it("starts only EMAIL_OTP for an invited address and stores no OTP code", async () => {
  const response = await handler(event("POST /api/guest/lectures/{shareId}/request-code", { email: "GUEST@example.com" }));
  expect(status(response)).toBe(202);
  const auth = m.cognito.mock.calls.map((c) => c[0]).find((c) => c.constructor.name === "AdminInitiateAuthCommand");
  expect(auth.input.AuthParameters).toMatchObject({ USERNAME: "canonical-user", PREFERRED_CHALLENGE: "EMAIL_OTP" });
  expect(auth.input.AuthParameters.SECRET_HASH).toBeTruthy();
  const stored = m.ddb.mock.calls.map((c) => c[0].input).find((input) => input.Item?.session);
  expect(stored.Item.email).toBe(guest);
  expect(stored.Item).not.toHaveProperty("code");
  expect(stored.Item.attempts).toBe(0);
  const rate = m.ddb.mock.calls[0]![0].input;
  expect(rate.ExpressionAttributeNames["#ttl"]).toBe("ttl"); // DynamoDB reserves this attribute name.
  expect(rate.UpdateExpression).toContain("#ttl = :ttl");
});

it.each(["01234567", "012345", "aB12cD34"])("forwards the complete code %s and requires verified email before issuing a cookie", async (code) => {
  m.ddb.mockImplementation(async (c) => c.constructor.name === "GetCommand" ? { Item: challenge() } : {});
  const response = await handler(event("POST /api/guest/lectures/{shareId}/verify-code", { challengeId, code }));
  expect(status(response)).toBe(200);
  expect(response).toMatchObject({ body: '{"verified":true}', cookies: [expect.stringContaining("HttpOnly; Secure; SameSite=Lax")] });
  expect(m.verify).toHaveBeenCalledWith("synthetic-token");
  const command = m.cognito.mock.calls.map((call) => call[0]).find((command) => command.constructor.name === "AdminRespondToAuthChallengeCommand");
  expect(command.input.ChallengeResponses.EMAIL_OTP_CODE).toBe(code);
  for (const command of m.ddb.mock.calls.map((c) => c[0].input).filter((c) => c.ConditionExpression)) {
    expect(command.ConditionExpression).toContain("#ttl > :now");
    expect(command.ExpressionAttributeNames["#ttl"]).toBe("ttl");
  }
});

it("rejects expired, replayed and cross-share challenges before calling Cognito", async () => {
  for (const item of [{ ...challenge(), ttl: 1 }, { ...challenge(), usedAt: 1 }, { ...challenge(), shareId: challengeId }]) {
    m.ddb.mockResolvedValue({ Item: item }); m.cognito.mockClear();
    expect(status(await handler(event("POST /api/guest/lectures/{shareId}/verify-code", { challengeId, code: "012345" })))).toBe(400);
    expect(m.cognito).not.toHaveBeenCalled();
  }
});

it("stops verification when the attempt limit was reached", async () => {
  m.ddb.mockImplementation(async (c) => {
    if (c.constructor.name === "GetCommand") return { Item: challenge() };
    throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
  });
  expect(status(await handler(event("POST /api/guest/lectures/{shareId}/verify-code", { challengeId, code: "012345" })))).toBe(400);
  expect(m.cognito).not.toHaveBeenCalled();
});

it("does not authenticate a wrong code or an unverified/mismatched email", async () => {
  m.ddb.mockResolvedValue({ Item: challenge() });
  m.cognito.mockRejectedValueOnce(Object.assign(new Error(), { name: "CodeMismatchException" }));
  expect(status(await handler(event("POST /api/guest/lectures/{shareId}/verify-code", { challengeId, code: "000000" })))).toBe(400);
  m.cognito.mockResolvedValue({ AuthenticationResult: { IdToken: "synthetic-token" } });
  for (const claims of [{ email: guest, email_verified: false }, { email: "other@example.com", email_verified: true }]) {
    m.verify.mockResolvedValue(claims);
    expect(status(await handler(event("POST /api/guest/lectures/{shareId}/verify-code", { challengeId, code: "012345" })))).toBe(403);
  }
});

it("confirms a stale first-OTP claim only against the same verified Cognito identity", async () => {
  m.ddb.mockImplementation(async (c) => c.constructor.name === "GetCommand" ? { Item: challenge() } : {});
  m.verify.mockResolvedValue({ sub: "subject-1", "cognito:username": "canonical-user", email: guest, email_verified: false });
  m.cognito.mockImplementation(async (c) => {
    if (c.constructor.name === "AdminGetUserCommand") {
      expect(c.input.Username).toBe("canonical-user");
      return { Enabled: true, UserStatus: "CONFIRMED", UserAttributes: [
        { Name: "sub", Value: "subject-1" }, { Name: "email", Value: guest }, { Name: "email_verified", Value: "true" },
      ] };
    }
    if (c.constructor.name === "DescribeUserPoolClientCommand") return { UserPoolClient: { ClientSecret: "synthetic-test-secret" } };
    return { AuthenticationResult: { IdToken: "synthetic-token" } };
  });
  expect(status(await handler(event("POST /api/guest/lectures/{shareId}/verify-code", { challengeId, code: "01234567" })))).toBe(200);
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(200);
});

it.each([
  { sub: "other-subject", email: guest, verified: "true", enabled: true },
  { sub: "subject-1", email: "other@example.com", verified: "true", enabled: true },
  { sub: "subject-1", email: guest, verified: "false", enabled: true },
  { sub: "subject-1", email: guest, verified: "true", enabled: false },
])("does not use another, unverified or disabled profile to confirm a token: %j", async ({ sub, email, verified, enabled }) => {
  m.verify.mockResolvedValue({ sub: "subject-1", "cognito:username": "canonical-user", email: guest, email_verified: false });
  m.cognito.mockResolvedValue({ Enabled: enabled, UserStatus: "CONFIRMED", UserAttributes: [
    { Name: "sub", Value: sub }, { Name: "email", Value: email }, { Name: "email_verified", Value: verified },
  ] });
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(401);
  expect(m.read).not.toHaveBeenCalled();
});

it("accepts a signed string true flag but never treats string false as verified", async () => {
  m.verify.mockResolvedValueOnce({ email: guest, email_verified: "true" });
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(200);
  m.verify.mockResolvedValueOnce({ email: guest, email_verified: "false" });
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(401);
});

it("resolves an omitted email claim only from the signed subject's verified provider record", async () => {
  m.verify.mockResolvedValue({ sub: "subject-1", "cognito:username": "canonical-user" });
  m.cognito.mockResolvedValue({ Enabled: true, UserStatus: "CONFIRMED", UserAttributes: [
    { Name: "sub", Value: "subject-1" }, { Name: "email", Value: guest }, { Name: "email_verified", Value: "true" },
  ] });
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(200);
  m.verify.mockResolvedValue({ sub: "subject-2", "cognito:username": "canonical-user" });
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(401);
});

it("requires a valid verified guest token and current invitation for every read", async () => {
  const route = "GET /api/guest/lectures/{shareId}";
  expect(status(await handler(event(route)))).toBe(401);
  expect(m.read).not.toHaveBeenCalled();
  m.verify.mockRejectedValueOnce(new Error("wrong issuer"));
  expect(status(await handler(event(route, undefined, true)))).toBe(401);
  m.verify.mockResolvedValueOnce({ email: "other@example.com", email_verified: true });
  expect(status(await handler(event(route, undefined, true)))).toBe(403);
  m.share.mockResolvedValueOnce({ ...share(), revokedAt: "now" });
  expect(status(await handler(event(route, undefined, true)))).toBe(404);
  m.share.mockResolvedValueOnce({ ...share(), ttl: 1 });
  expect(status(await handler(event(route, undefined, true)))).toBe(404);
  expect(m.read).not.toHaveBeenCalled();
});

it("returns scoped notes and authenticated image paths without private storage paths or owner prompts", async () => {
  const response = await handler(event("GET /api/guest/lectures/{shareId}", undefined, true));
  expect(status(response)).toBe(200);
  const body = typeof response === "object" ? response.body! : "";
  expect(body).not.toContain("lecture-results/");
  expect(body).not.toContain("owner preference");
  expect(body).not.toContain("calls");
  expect(JSON.parse(body).images).toEqual([{ page: 1, sourcePage: 38, url: `/api/guest/lectures/${shareId}/images/1` }]);
});

it("checks revocation on image requests and never accepts a caller-supplied S3 key", async () => {
  const request = event("GET /api/guest/lectures/{shareId}/images/{imageId}", undefined, true);
  request.pathParameters!["imageId"] = "../../other";
  expect(status(await handler(request))).toBe(404);
  request.pathParameters!["imageId"] = "1";
  m.share.mockResolvedValue({ ...share(), revokedAt: "now" });
  expect(status(await handler(request))).toBe(404);
  expect(m.s3).not.toHaveBeenCalled();
});

it("rejects stale ownership and cross-origin requests", async () => {
  m.lecture.mockResolvedValue({ owner: "another-owner", documentKey: "lecture-results/lecture-1/document.json" });
  expect(status(await handler(event("GET /api/guest/lectures/{shareId}", undefined, true)))).toBe(404);
  const request = event("POST /api/guest/lectures/{shareId}/request-code", { email: guest });
  request.headers["origin"] = "https://untrusted.example";
  expect(status(await handler(request))).toBe(403);
  expect(m.cognito).not.toHaveBeenCalled();
});

it("treats database TTL as cleanup only and compares expiry during authorization", () => {
  expect(() => activeShare({ ...share(), ttl: 100 }, 100)).toThrow();
  expect(invited(share(), " GUEST@EXAMPLE.COM ")).toBe(true);
});
