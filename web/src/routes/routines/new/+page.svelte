<script lang="ts">
	import { goto } from "$app/navigation";

	type StepRow = { tool: string; argsText: string };

	let name = "";
	let description = "";
	type TriggerKind = "cron" | "graph_event" | "chat_intent";
	let triggerKind: TriggerKind = "cron";
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

	const TRIGGERS: { value: TriggerKind; label: string; tone: string }[] = [
		{ value: "cron",        label: "Schedule (cron)",  tone: "badge-blue" },
		{ value: "graph_event", label: "Graph event",      tone: "badge-cyan" },
		{ value: "chat_intent", label: "Chat intent",      tone: "badge-violet" },
	];
</script>

<header>
	<p class="section-eyebrow">Automation · Setup</p>
	<h1 class="font-display text-h2 text-strong">New routine</h1>
	<p class="mt-2 max-w-prose-tight text-sm text-subtle">
		One trigger + an ordered list of steps. Each step calls a tool from the agent's registry.
	</p>
</header>

<form class="mt-l space-y-l" on:submit|preventDefault={save}>
	<!-- Identity -->
	<section class="surface-card">
		<header class="mb-3">
			<h2 class="font-display text-h5 text-strong">Identity</h2>
		</header>
		<div class="grid grid-cols-1 gap-3">
			<label class="field">
				<span class="field-label">Name</span>
				<input class="input" required maxlength="120" bind:value={name} placeholder="Weekday GNC summary" />
			</label>
			<label class="field">
				<span class="field-label">Description (optional)</span>
				<input class="input" maxlength="500" bind:value={description} />
			</label>
			<label class="inline-flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={enabled} />
				<span class="text-default">Enabled on save</span>
			</label>
		</div>
	</section>

	<!-- Trigger -->
	<section class="surface-card">
		<header class="mb-3">
			<h2 class="font-display text-h5 text-strong">Trigger</h2>
			<p class="text-xs text-subtle">Choose when this routine fires.</p>
		</header>

		<div class="mb-3 flex flex-wrap gap-2">
			{#each TRIGGERS as t}
				<label class="cursor-pointer">
					<input class="peer sr-only" type="radio" bind:group={triggerKind} value={t.value} />
					<span class="badge {t.tone} px-3 py-1.5 text-sm peer-checked:ring-2 peer-checked:ring-offset-2"
						style="--tw-ring-color: var(--brand);"
						class:ring-2={triggerKind === t.value}
						class:ring-offset-2={triggerKind === t.value}>
						{t.label}
					</span>
				</label>
			{/each}
		</div>

		{#if triggerKind === "cron"}
			<label class="field">
				<span class="field-label">5-field cron expression (UTC, whole-minute)</span>
				<input class="input font-mono" required bind:value={cronExpr} placeholder="0 13 * * 1-5" />
				<span class="field-help">
					Example: <span class="kbd">0 13 * * 1-5</span> = 1pm UTC, Mon–Fri.
					The hourly worker cron dispatches every routine whose expression matches "now".
				</span>
			</label>
		{:else if triggerKind === "graph_event"}
			<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
				<label class="field md:col-span-2">
					<span class="field-label">Graph resource</span>
					<input class="input font-mono" required bind:value={graphResource}
						placeholder="teams/{`{teamId}`}/channels/{`{channelId}`}/messages" />
				</label>
				<label class="field">
					<span class="field-label">Change type</span>
					<select class="select" bind:value={graphChangeType}>
						<option value="created">created</option>
						<option value="updated">updated</option>
						<option value="deleted">deleted</option>
					</select>
				</label>
			</div>
			<p class="field-help">
				graph_event triggers fire when a Graph subscription notification matches the resource.
				Wire-up follow-up.
			</p>
		{:else}
			<label class="field">
				<span class="field-label">Chat-intent regex pattern</span>
				<input class="input font-mono" required bind:value={chatPattern}
					placeholder="^summarise (\\w+) status$" />
			</label>
		{/if}
	</section>

	<!-- Steps -->
	<section class="surface-card">
		<header class="mb-3 flex items-center justify-between">
			<div>
				<h2 class="font-display text-h5 text-strong">Steps</h2>
				<p class="text-xs text-subtle">Run in order. Each step's <span class="kbd">args</span> must be valid JSON.</p>
			</div>
			<button type="button" class="btn-secondary btn-sm" on:click={addStep}>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
				Add step
			</button>
		</header>

		<ol class="space-y-3">
			{#each steps as step, i}
				<li class="rounded-m border border-hairline bg-recessed p-3">
					<div class="mb-2 flex items-center gap-2">
						<span class="badge badge-solid">{i + 1}</span>
						<select class="select flex-1" bind:value={step.tool}>
							{#each TOOLS as t}<option value={t}>{t}</option>{/each}
						</select>
						{#if steps.length > 1}
							<button type="button" class="btn-ghost btn-sm" on:click={() => removeStep(i)}>Remove</button>
						{/if}
					</div>
					<label class="field">
						<span class="field-label">args (JSON)</span>
						<textarea class="textarea font-mono text-xs" rows="3" bind:value={step.argsText}></textarea>
					</label>
				</li>
			{/each}
		</ol>
	</section>

	{#if error}
		<div class="banner banner-danger"><div><strong>Error.</strong> {error}</div></div>
	{/if}

	<footer class="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-hairline bg-elevated px-4 py-3 md:-mx-8 md:px-8">
		<a class="btn-secondary" href="/routines">Cancel</a>
		<button class="btn-primary" type="submit" disabled={saving || !name.trim()}>
			{#if saving}
				<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
				Saving
			{:else}
				Save routine
			{/if}
		</button>
	</footer>
</form>
