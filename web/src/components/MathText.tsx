import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

type Part = { text: string; html?: undefined; display?: undefined } | { text?: undefined; html: string; display: boolean };
// trust:false blocks \href, \url and \includegraphics; KaTeX escapes everything else, so its markup is safe to inject.
const OPTIONS = { throwOnError: false, trust: false, strict: "ignore" as const, maxExpand: 1000, maxSize: 50 };

/** A complete formula already isolated by a surrounding rich-text parser. */
export function MathFormula({ expression, display = false }: { expression: string; display?: boolean }) {
  const html = useMemo(() => katex.renderToString(expression.trim(), { ...OPTIONS, displayMode: display }), [expression, display]);
  return <span className={display ? "block overflow-x-auto py-1" : "inline-block max-w-full overflow-x-auto align-middle"} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Lecture text with LaTeX: $...$ renders inline, $$...$$ as a block; everything else stays plain text. */
export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => split(text), [text]);
  return <span className={className}>{parts.map((part, i) => part.html === undefined ? part.text
    : <span key={i} className={part.display ? "block overflow-x-auto py-1" : undefined} dangerouslySetInnerHTML={{ __html: part.html }} />)}</span>;
}

function split(text: string): Part[] {
  const parts: Part[] = []; const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g; let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    const display = match[1] !== undefined;
    parts.push({ html: katex.renderToString((match[1] ?? match[2] ?? "").trim(), { ...OPTIONS, displayMode: display }), display });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
