import { boot } from "./runtime/index.js";
import { page } from "./site-actions.js";

page.selection = "Assistant settings";
const status = document.getElementById("mount-status");
try {
  const base = new URL("./", location.href);
  await boot("#app", {
    originUrl: base.href.replace(/\/$/, ""),
    sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", base).href,
  });
  status.hidden = true;
} catch (error) {
  status.textContent = "Assistant unavailable · " + error.message;
}
