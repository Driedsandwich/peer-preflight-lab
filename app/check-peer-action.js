import { maxPeerUrlLength } from "./preflight.js";

export const checkPeerAction = {
  name: "check_peer",
  effect: "read",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string", minLength: 1, maxLength: maxPeerUrlLength,
        description: "Exact peer network URL, ending with the published name. Use the visitor's URL or a sample link.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};
