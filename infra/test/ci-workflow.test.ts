import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

it("requires real MP4 tests without introducing private deployment credentials", () => {
  expect(workflow).toContain("if: matrix.directory == 'lecture'");
  expect(workflow).toContain("sudo apt-get install -y ffmpeg");
  expect(workflow).toContain("uv run --extra dev pytest -q ${{ matrix.directory == 'lecture' && '--require-media' || '' }}");
  expect(workflow).toContain("contents: read");
  expect(workflow).not.toContain("id-token: write");
  expect(workflow).not.toMatch(/^  deploy:/m);
  expect(workflow).not.toContain("meeting-notes-runners");
});
