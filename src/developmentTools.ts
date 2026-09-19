import { tool } from "@lmstudio/sdk";

// Kept for development; deliberately absent from the analysis tools provider.
export const sherpaPing = tool({
  name: "sherpa_ping",
  description: "Check DFIR Sherpa connectivity. Returns a fixed status without file or network access.",
  parameters: {},
  implementation: async () => '{"ok":true,"plugin":"dfir-sherpa","stage":1}',
});
