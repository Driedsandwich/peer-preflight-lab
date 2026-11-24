export const page = {
  selection: "No check selected",
  readCheck() { return { check: this.selection }; },
};

export function registerActions(actions) {
  actions.register({
    name: "read_check",
    description: "Read the check currently selected on this page.",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => page.readCheck(),
  });
}
