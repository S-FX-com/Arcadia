import { parseAssignCommand, handleAssignCommand } from "../../tasks/assign.js";
import type { IntentHandler } from "./types.js";

export const handle: IntentHandler = async (ctx) => {
  const parsed = parseAssignCommand(ctx.command.rawText);
  if (!parsed) {
    return {
      text: "I couldn't parse that assignment. Try: `@Arcadia assign [task] to [name]`",
    };
  }
  const text = await handleAssignCommand(ctx.activity, parsed, ctx.env);
  return { text };
};
