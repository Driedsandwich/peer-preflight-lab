// Node's ESM loader reads the same bytes the browser imports from this one URL.
export function resolve(specifier, context, nextResolve) {
  if (specifier === "http://127.0.0.1:8081/site-actions.js") {
    return { url: new URL("../lab-caller/site-actions.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
