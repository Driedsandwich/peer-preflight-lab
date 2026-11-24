import { callerBase } from "../lab-caller/origins.js";

// Node's ESM loader reads the same bytes the browser imports from this one URL.
export function resolve(specifier, context, nextResolve) {
  if (specifier === callerBase + "/site-actions.js") {
    return { url: new URL("../lab-caller/site-actions.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
