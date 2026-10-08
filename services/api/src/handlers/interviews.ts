import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { completeInterviewUploadSchema, createInterviewSchema, interviewSettingsSchema, toInterviewDto } from "@meeting-notes/shared";
import { InterviewLimitError, listInterviews } from "@meeting-notes/backend";
import { callerFrom, HttpError, json, parseBody, pathParam } from "../lib/http.js";
import { completeInterviewUpload, createInterview, interviewMarkdown, interviewResult, removeInterview, startInterview, updateInterviewSettings } from "../routes/interviews.js";

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    const caller = callerFrom(event);
    if (event.routeKey === "POST /api/interviews") return json(201, await createInterview(caller, parseBody(event, createInterviewSchema)));
    if (event.routeKey === "GET /api/interviews") {
      const cursor = event.queryStringParameters?.["cursor"];
      if (cursor && !/^[\w-]{1,2048}$/.test(cursor)) throw new HttpError(400, "invalid cursor");
      const page = await listInterviews(caller.sub, cursor);
      return json(200, { items: page.items.map(toInterviewDto), cursor: page.cursor });
    }
    const id = pathParam(event, "id");
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "인터뷰를 찾을 수 없습니다", "not_found");
    switch (event.routeKey) {
      case "GET /api/interviews/{id}/result": return json(200, await interviewResult(caller, id));
      case "GET /api/interviews/{id}/markdown": return {
        statusCode: 200,
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, no-store",
          "content-disposition": 'attachment; filename="interview.md"', "x-content-type-options": "nosniff" },
        isBase64Encoded: true,
        body: (await interviewMarkdown(caller, id)).toString("base64"),
      };
      case "POST /api/interviews/{id}/complete-upload": await completeInterviewUpload(caller, id, parseBody(event, completeInterviewUploadSchema)); return json(204, {});
      case "POST /api/interviews/{id}/start": return json(202, await startInterview(caller, id));
      case "POST /api/interviews/{id}/retry": return json(202, await startInterview(caller, id, true));
      case "PATCH /api/interviews/{id}/settings": return json(200, await updateInterviewSettings(caller, id, parseBody(event, interviewSettingsSchema)));
      case "DELETE /api/interviews/{id}": await removeInterview(caller, id); return json(204, {});
      default: return json(404, { error: "not_found" });
    }
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message });
    if (error instanceof InterviewLimitError) return json(429, { error: "too_many_active", message: error.message });
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return json(409, { error: "conflict", message: "상태가 변경되었습니다. 새로고침 후 다시 시도하세요" });
    console.error("interview API error", { route: event.routeKey, error });
    return json(500, { error: "internal", message: "인터뷰 요청을 처리하지 못했습니다" });
  }
};
