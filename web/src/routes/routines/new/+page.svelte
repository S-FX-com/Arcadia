<script lang="ts">
	import { goto } from "$app/navigation";

	type StepRow = { tool: string; argsText: string };

	let name = "";
	let description = "";
	let triggerKind: "cron" | "graph_event" | "chat_intent" = "cron";
	let cronExpr = "0 13 * * 1-5";
	let graphResource = "";
	let graphChangeType: "created" | "updated" | "deleted" = "created";
	let chatPattern = "";
	let enabled = true;
	let steps: StepRow[] = [{ tool: "search_memory", argsText: '{ "query": "" }' }];
	let saving = false;
	let error = "";

	const TOOLS = [
		"search_memory",
		"search_documents",
		"search_teams_messages",
		"get_calendar",
		"send_mail",
		"post_channel",
		"create_planner_task",
		"create_event",
	];

	function addStep() { steps = [...steps, { tool: "search_memory", argsText: "{}" }]; }
	function removeStep(i: number) { steps = steps.filter((_, idx) => idx !== i); }

	async function save() {
		error = "";
		saving = true;
		try {
			const trigger =
				triggerKind === "cron"        ? { kind: "cron", expr: cronExpr }
			  : triggerKind === "graph_event" ? { kind: "graph_event", resource: graphResource, changeType: graphChangeType }
			  :                                  { kind: "chat_intent", pattern: chatPattern };

			const parsedSteps = steps.map((s, i) => {
				let args: unknown;
				try { args = s.argsText.trim() ? JSON.parse(s.argsText) : {}; }
				catch { throw new Error(`Step ${i + 1} (${s.tool}): args is not valid JSON`); }
				return { tool: s.tool, args };
			});

			const body = {
				name,
				description: description || undefined,
				trigger,
				steps: parsedSteps,
				enabled,
			};

			const res = await fetch("/api/webapp/routines", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "include",
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`HTTP ${res.status}: ${text}`);
			}
			await goto("/routines");
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<header>
	<h1 class="text-xl font-semibold">New routine</h1>
	<p class="mt-1 text-sm text-zinc-500">
		One trigger + an ordered list of steps. Each step calls a tool from the agent's registry.
	</p>
</header>

<form class="mt-6 space-y-6" on:submit|preventDefault={save}>
	<section class="space-y-3">
		<label class="block">
			<span class="text-sm font-medium">Name</span>
			<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				required maxlength="120" bind:value={name} placeholder="Weekday GNC summary" />
		</label>
		<label class="block">
			<span class="text-sm font-medium">Description (optional)</span>
			<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				maxlength="500" bind:value={description} />
		</label>
		<label class="inline-flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={enabled} />
			<span>Enabled</span>
		</label>
	</section>

	<section class="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
		<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Trigger</h2>
		<div class="flex gap-2">
			{#each ["cron", "graph_event", "chat_intent"] as k}
				<label class="chip cursor-pointer" class:!bg-zinc-900={triggerKind === k} class:!text-white={triggerKind === k}>
					<input class="hidden" type="radio" bind:group={triggerKind} value={k} />
					{k}
				</label>
			{/each}
		</div>

		{#if triggerKind === "cron"}
			<label class="block">
				<span class="text-xs text-zinc-500">5-field cron expression (UTC, whole-minute)</span>
				<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					required bind:value={cronExpr} placeholder="0 13 * * 1-5" />
			</label>
			<p class="text-xs text-zinc-500">
				Example: <code>0 13 * * 1-5</code> = 1pm UTC, Mon–Fri.
				The hourly worker cron dispatches every routine whose expression matches "now".
			</p>
		{:else if triggerKind === "graph_event"}
			<label class="block">
				<span class="text-xs text-zinc-500">Graph resource (e.g. <code>teams/{`{teamId}`}/channels/{`{channelId}`}/messages</code>)</span>
				<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					required bind:value={graphResource} />
			</label>
			<label class="block">
				<span class="text-xs text-zinc-500">Change type</span>
				<select class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					bind:value={graphChangeType}>
					<option value="created">created</option>
					<option value="updated">updated</option>
					<option value="deleted">deleted</option>
				</select>
			</label>
			<p class="text-xs text-zinc-500">
				graph_event triggers fire when a Graph subscription notification matches the resource. Wire-up follow-up.
			</p>
		{:else}
			<label class="block">
				<span class="text-xs text-zinc-500">Chat-intent regex pattern</span>
				<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					required bind:value={chatPattern} placeholder="^summarise (\\w+) status$" />
			</label>
		{/if}
	</section>

	<section class="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
		<header class="flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Steps</h2>
			<button type="button" class="btn" on:click={addStep}>+ step</button>
		</header>
		{#each steps as step, i}
			<div class="space-y-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
				<header class="flex items-center justify-between gap-2">
					<select class="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						bind:value={step.tool}>
						{#each TOOLS as t}<option value={t}>{t}</option>{/each}
					</select>
					{#if steps.length > 1}
						<button type="button" class="btn" on:click={() => removeStep(i)}>Remove</button>
					{/if}
				</header>
				<label class="block">
					<span class="text-xs text-zinc-500">args (JSON)</span>
					<textarea class="mt-1 w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
						rows="3" bind:value={step.argsText}></textarea>
				</label>
			</div>
		{/each}
	</section>

	{#if error}
		<p class="text-sm text-red-500">{error}</p>
	{/if}

	<footer class="flex justify-end gap-2">
		<a class="btn" href="/routines">Cancel</a>
		<button class="btn" type="submit" disabled={saving || !name.trim()}>
			{saving ? "Saving…" : "Save routine"}
		</button>
	</footer>
</form>
