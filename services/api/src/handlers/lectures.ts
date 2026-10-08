import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { completeLectureUploadSchema, createLectureSchema, createLectureShareSchema, toLectureDto } from "@meeting-notes/shared";
import { LectureLimitError, listLectures } from "@meeting-notes/backend";
import { callerFrom, HttpError, json, parseBody, pathParam } from "../lib/http.js";
import { completeLectureUpload, createLecture, lectureResult, ownedLecture, removeLecture, startLecture } from "../routes/lectures.js";
import { createLectureShare, listLectureShares, revokeLectureShare } from "../routes/lecture-sharing.js";

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    const caller = callerFrom(event);
    if (event.routeKey === "POST /api/lectures") return json(201, await createLecture(caller, parseBody(event, createLectureSchema)));
    if (event.routeKey === "GET /api/lectures") {
      const cursor = event.queryStringParameters?.["cursor"];
      if (cursor && (!/^[\w-]{1,2048}$/.test(cursor))) throw new HttpError(400, "invalid cursor");
      const page = await listLectures(caller.sub, cursor);
      return json(200, { items: page.items.map(toLectureDto), cursor: page.cursor });
    }
    const id = pathParam(event, "id");
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "강의를 찾을 수 없습니다", "not_found");
    switch (event.routeKey) {
      case "POST /api/lectures/{id}/shares": return json(201, await createLectureShare(caller, id, parseBody(event, createLectureShareSchema)));
      case "GET /api/lectures/{id}/shares": return json(200, await listLectureShares(caller, id));
      case "DELETE /api/lectures/{id}/shares/{shareId}": {
        const shareId = pathParam(event, "shareId");
        if (!z.string().uuid().safeParse(shareId).success) throw new HttpError(404, "공유 링크를 찾을 수 없습니다");
        await revokeLectureShare(caller, id, shareId);
        return json(204, {});
      }
      case "GET /api/lectures/{id}": return json(200, { lecture: toLectureDto(await ownedLecture(caller, id)) });
      case "GET /api/lectures/{id}/result": return json(200, await lectureResult(caller, id));
      case "POST /api/lectures/{id}/complete-upload": await completeLectureUpload(caller, id, parseBody(event, completeLectureUploadSchema)); return json(204, {});
      case "POST /api/lectures/{id}/start": return json(202, await startLecture(caller, id));
      case "POST /api/lectures/{id}/retry": return json(202, await startLecture(caller, id, true));
      case "DELETE /api/lectures/{id}": await removeLecture(caller, id); return json(204, {});
      default: return json(404, { error: "not_found" });
    }
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message });
    if (error instanceof LectureLimitError) return json(429, { error: "too_many_active", message: error.message });
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return json(409, { error: "conflict", message: "상태가 변경되었습니다. 새로고침 후 다시 시도하세요" });
    console.error("lecture API error", { route: event.routeKey, error });
    return json(500, { error: "internal", message: "강의 처리 요청에 실패했습니다. 다시 시도하세요" });
  }
};
