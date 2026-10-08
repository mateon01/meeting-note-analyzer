// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnswerText } from "../../components/chat/AnswerText";

let element: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
async function render(text: string, onRef = vi.fn(), streaming = false) {
  await act(async () => { root.render(<AnswerText text={text} onRef={onRef} streaming={streaming} />); });
}

it("renders CTC equations and keeps adjacent evidence buttons clickable", async () => {
  const ref = vi.fn();
  await render(String.raw`Forward 변수 $\alpha_t(s)$는 앞부분의 확률입니다. [E9][E4]

$$
P(l|x,\theta)=\alpha_T(|\acute l|-1)

+\alpha_T(|\acute l|)
$$

결과를 합하면 됩니다.`, ref);
  await vi.waitFor(() => expect(element.querySelectorAll(".katex")).toHaveLength(2));
  expect(element.querySelectorAll(".katex-display")).toHaveLength(1);
  const buttons = [...element.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["E9", "E4"]);
  await act(async () => buttons[0]!.click());
  expect(ref).toHaveBeenCalledWith("E9");
});

it("supports backslash math delimiters and does not turn references inside formulas into buttons", async () => {
  await render(String.raw`정의 \(\beta_t(s)\)와 \[x_{[E2]}=\frac{1}{2}\]를 봅니다. [E1]`);
  await vi.waitFor(() => expect(element.querySelectorAll(".katex")).toHaveLength(2));
  expect([...element.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["E1"]);
});

it("keeps incomplete streamed math visible until its closing delimiter arrives", async () => {
  await render(String.raw`계산은 $\alpha_t(s)`, vi.fn(), true);
  expect(element.textContent).toContain(String.raw`$\alpha_t(s)`);
  await render(String.raw`계산은 $\alpha_t(s)=0$입니다. [E1]`);
  await vi.waitFor(() => expect(element.querySelector(".katex")).not.toBeNull());
  expect(element.querySelector("button")?.textContent).toBe("E1");
});

it("does not execute HTML or trusted KaTeX commands from a response", async () => {
  await render(String.raw`<img src=x onerror=alert(1)> $\href{javascript:alert(1)}{x}$ [E1]`);
  await vi.waitFor(() => expect(element.querySelector(".katex")).not.toBeNull());
  expect(element.querySelector("img, script, a")).toBeNull();
  expect(element.textContent).toContain("<img");
});
