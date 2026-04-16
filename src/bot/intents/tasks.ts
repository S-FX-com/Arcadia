import { getOpenTasksForChannel } from "../../tasks/store.js";
import { formatTaskList } from "../messages.js";
import type { IntentHandler } from "./types.js";

export const handle: IntentHandler = async (ctx) => {
  const tasks = await getOpenTasksForChannel(ctx.teamId, ctx.channelId, ctx.env);
  return { text: formatTaskList(tasks, ctx.command.language) };
};
