// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import type { ChatEvidence } from "@meeting-notes/shared";
import { EvidenceCard } from "../../components/chat/EvidenceCard";

let root: Root; let element: HTMLDivElement;
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
async function render(item: ChatEvidence) {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  await act(async () => root.render(<MemoryRouter><EvidenceCard item={item} /></MemoryRouter>));
}
const base = { id: "E1", title: "선형대수학 1주차", date: "2026-09-06", meetingType: null, snippet: "체는 두 연산을 가진 집합", score: 0.9, startSec: null, segmentIds: [], url: "" };

it("links lecture evidence to the lecture page section", async () => {
  await render({ ...base, kind: "lecture", meetingId: null, lectureId: "lec-1", page: 5 });
  expect(element.querySelector("a")?.getAttribute("href")).toBe("/lectures/lec-1?page=5");
  expect(element.textContent).toContain("강의 학습 항목 5");
});
it("keeps meeting transcript links with the seek time", async () => {
  await render({ ...base, kind: "transcript", meetingId: "m-1", startSec: 65 });
  expect(element.querySelector("a")?.getAttribute("href")).toBe("/meetings/m-1?t=65");
});
