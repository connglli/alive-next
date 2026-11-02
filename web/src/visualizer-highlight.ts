import hljs from "highlight.js/lib/core";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import llvm from "highlight.js/lib/languages/llvm";

// The shared visualizer discovers this object after its deferred assets load.
hljs.registerLanguage("llvm", llvm);
hljs.registerLanguage("json", json);
hljs.registerLanguage("diff", diff);
Object.assign(globalThis, { hljs });
