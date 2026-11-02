import hljs from "highlight.js/lib/core";
import llvm from "highlight.js/lib/languages/llvm";
import { INPUT_BYTES } from "./limits.ts";

// Use the visualizer's LLVM grammar without bundling unrelated languages.
hljs.registerLanguage("llvm", llvm);

export function highlight(target: HTMLElement, source: string) {
  const code = document.createElement("code");
  code.className = "syntax-code language-llvm";
  // Source enters as text; Highlight.js supplies the escaped token markup.
  code.textContent = source;

  // Keep editing responsive for oversized inputs and retain plain-text fallback.
  if (source.length <= INPUT_BYTES) {
    try {
      hljs.highlightElement(code);
    } catch {
      code.textContent = source;
      code.classList.remove("hljs");
      delete code.dataset.highlighted;
    }
  }

  target.replaceChildren(code);
}
