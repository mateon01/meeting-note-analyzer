import { lazy, Suspense, type ReactNode } from "react";

const REF_RE = /\[(E\d+)\]/g;
const MATH_RE = /\$\$[\s\S]+?\$\$|(?<!\\)\$(?:\\.|[^$\\\n])+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g;
// Plain meeting conversations do not need to download the math renderer.
const Formula = lazy(() => import("../MathText").then((m) => ({ default: m.MathFormula })));

/** Preserve complete formulas, including multiline displays, while rendering citations. */
export function AnswerText({ text, onRef, streaming }: { text: string; onRef: (id: string) => void; streaming?: boolean }) {
  const blocks = paragraphBlocks(text);
  return (
    <div className="space-y-2.5 text-[15px] leading-relaxed text-ink">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const hasMultilineMath = [...block.matchAll(new RegExp(MATH_RE.source, "g"))].some((m) => m[0].includes("\n"));
        const isList = !hasMultilineMath && lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="space-y-1.5 pl-1">
              {lines.map((l, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />
                  <span className="min-w-0 flex-1">{withRefs(l.replace(/^\s*([-*]|\d+[.)])\s+/, ""), onRef)}</span>
                </li>
              ))}
            </ul>
          );
        }
        const heading = /^#{1,3}\s+/.test(block);
        return heading ? <p key={i} className="font-semibold">{withRefs(block.replace(/^#{1,3}\s+/, ""), onRef)}</p> : <p key={i} className="whitespace-pre-wrap">{withRefs(block, onRef)}</p>;
      })}
      {streaming && <span className="inline-block h-4 w-[2px] animate-pulse bg-accent align-text-bottom" />}
    </div>
  );
}

function withRefs(line: string, onRef: (id: string) => void): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(`${MATH_RE.source}|${REF_RE.source}`, "g");
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push(line.slice(last, m.index).replace(/\*\*/g, ""));
    if (!m[1]) {
      const raw = m[0];
      const display = raw.startsWith("$$") || raw.startsWith("\\[");
      const delimiter = raw.startsWith("\\") || display ? 2 : 1;
      parts.push(<Suspense key={`math-${m.index}`} fallback={<span>{raw}</span>}>
        <Formula expression={raw.slice(delimiter, -delimiter)} display={display} />
      </Suspense>);
      last = m.index + raw.length;
      continue;
    }
    const id = m[1]!;
    parts.push(
      <button key={`${m.index}-${id}`} type="button" onClick={() => onRef(id)} className="tap mx-0.5 inline-flex h-5 items-center rounded-md bg-accent-soft px-1.5 align-text-bottom text-[11px] font-semibold text-accent">
        {id}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last).replace(/\*\*/g, ""));
  return parts;
}

function paragraphBlocks(text: string): string[] {
  const math = [...text.matchAll(new RegExp(MATH_RE.source, "g"))].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const blocks: string[] = []; let start = 0;
  for (const separator of text.matchAll(/\n{2,}/g)) {
    if (math.some((range) => range.start <= separator.index && separator.index < range.end)) continue;
    blocks.push(text.slice(start, separator.index));
    start = separator.index + separator[0].length;
  }
  blocks.push(text.slice(start));
  return blocks.filter((block) => block.trim());
}
