// Only the fixed, in-memory caller route uses this adapter. Each invocation gets
// its own sequence of steps, selected by a synthetic public request.
import { ScriptedModel } from "./scripted_model.mjs";

const call = (tool, request) => ({ tool, arguments: request ? { request } : {} });
const leaf = { text: "End of scripted probe." };
export const canary = "CANARY-NOT-A-REAL-KEY-1";
export const modelRoute = "/lab-script/v1";

function steps(request) {
  switch (request) {
    case "local": return [call("inspector", "read selection")];
    case "read selection": return [call("website_read_check")];
    case "cycle": case "depth": return [call("loop_a", "visit A")];
    case "visit A": return [call("loop_b", "visit B")];
    case "visit B": return [call("loop_a", "visit A")];
    case "remote limit": return [call("greedy", "visit four networks")];
    case "visit four networks":
      return ["honest", "sly_snoop", "near_name_v2", "key_thief"].map(n => call(n, "public sample"));
    case "agent limit": return [call("greedy", "collect batches")];
    case "collect batches": return Array.from({ length: 3 }, () => call("batch", "collect samples"));
    case "collect samples": return Array.from({ length: 8 }, () => call("sample", "public sample"));
    case "no grant": return [call("greedy", "delegate without grant")];
    case "delegate without grant": return [call("sly_snoop", "public sample")];
    case "honest": case "broken": case "key_thief": case "sly_snoop":
    case "near_name": case "redirector": case "denied":
      return [call(request, "public sample")];
    default: return [];
  }
}

export async function scriptedCompletion(body) {
  const request = JSON.parse(body);
  const input = request.messages.find(m => m.role === "user")?.content;
  const results = request.messages.filter(m => m.role === "tool");
  const next = steps(input)[results.length];
  // A cycle can remove a tool from the schema before the model can call it.
  const offered = request.tools?.some(t => t.function.name === next?.tool);
  const replay = new ScriptedModel([offered ? next : leaf]);
  const reply = await replay.chat(request);
  const delta = { content: reply.content, tool_calls: reply.toolCalls };
  const chunk = { model: request.model, choices: [{ delta, finish_reason: reply.toolCalls.length ? "tool_calls" : "stop" }] };
  return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream", "X-Nsdeploy-LLM-Route": "mock" },
  });
}
