// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Planner producer (tasks across all plans the user owns)
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../constants.js";
import type { ProducedChange, Producer, ProducerContext, ProducerPage } from "./types.js";

interface Task {
	id: string;
	title?: string;
	planId?: string;
	dueDateTime?: string;
	percentComplete?: number;
	createdDateTime?: string;
}

interface Resp { value: Task[] }

export const plannerProducer: Producer = {
	resourceKey: () => "planner:me",
	resourceType: "planner_task",
	fetchPage: async (ctx: ProducerContext, _previousLink: string | null): Promise<ProducerPage> => {
		const res = await fetch(`${GRAPH.BASE_URL}/me/planner/tasks?$top=100`, {
			headers: { Authorization: `Bearer ${ctx.accessToken}` },
		});
		if (!res.ok) throw new Error(`planner fetch failed ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as Resp;

		const changes: ProducedChange[] = body.value.map((t) => {
			const text = `Task: ${t.title ?? ""}
Plan: ${t.planId ?? ""}
Due: ${t.dueDateTime ?? "(none)"}
Complete: ${t.percentComplete ?? 0}%`;
			const dataUri = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(text)))}`;
			return {
				message: {
					kind: "upsert",
					resourceType: "planner_task",
					resourceId: t.id,
					contentUri: dataUri,
					accessToken: ctx.accessToken,
					mime: "text/plain",
					...(t.title ? { title: t.title } : {}),
				},
				principals: [{ aadId: ctx.userAadId, kind: "user" }],
			};
		});

		return { changes, cursor: "planner:swept", done: true };
	},
};
