import { boot } from "./runtime/index.js";
import { page } from "./site-actions.js";

page.selection = "Assistant settings";
const status = document.getElementById("mount-status");
try {
  await boot("#app");
  status.hidden = true;
} catch (error) {
  status.textContent = "Assistant unavailable · " + error.message;
}
