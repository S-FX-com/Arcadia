<script lang="ts">
	import { onMount } from "svelte";

	import { api } from "$lib/api";
	import type { Routine } from "$lib/types";

	let routines: Routine[] = [];
	let error = "";
	let loading = true;

	onMount(async () => {
		try {
			const res = await api.routines();
			routines = res.routines;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	});

	async function runNow(id: string) {
		try {
			const out = await api.runRoutine(id) as { status: string };
			alert(`Status: ${out.status}`);
		} catch (e) {
			alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function toggleEnabled(r: Routine) {
		try {
			const res = await api.setRoutineEnabled(r.id, !r.enabled);
			routines = routines.map((x) => (x.id === r.id ? res.routine : x));
		} catch (e) {
			alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	function triggerLabel(t: Routine["trigger"]): string {
		if (t.kind === "cron") return `cron · ${t.cron}`;
		if (t.kind === "event") return `event · ${t.resource}`;
		return "manual";
	}

	function triggerBadge(kind: string): string {
		switch (kind) {
			case "cron":   return "badge badge-blue";
			case "event":  return "badge badge-cyan";
			case "manual": return "badge badge-violet";
			default:       return "badge badge-neutral";
		}
	}
</script>

<header class="flex items-start justify-between gap-4">
	<div>
		<p class="section-eyebrow">Automation</p>
		<h1 class="font-display text-h2 text-strong">Routines</h1>
		<p class="mt-2 max-w-prose-tight text-sm text-subtle">
			Saved automations that run on a schedule, on Graph events, or on chat intent.
		</p>
	</div>
	<a class="btn-primary" href="/routines/new">
		<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
		New routine
	</a>
</header>

{#if loading}
	<div class="mt-6 flex items-center gap-2 text-sm text-subtle" role="status">
		<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
		<span class="ml-1">Loading routines…</span>
	</div>
{:else if error}
	<div class="banner banner-danger mt-6"><div><strong>Error.</strong> {error}</div></div>
{:else if routines.length === 0}
	<div class="empty mt-6">
		<p class="font-display text-h4 text-strong">No routines yet</p>
		<p class="mt-1 text-sm text-subtle">The visual builder is on the way.</p>
		<a class="btn-primary mt-4" href="/routines/new">+ New routine</a>
	</div>
{:else}
	<ul class="mt-6 space-y-3">
		{#each routines as r}
			<li class="surface-card">
				<div class="flex items-start justify-between gap-4">
					<div class="min-w-0 flex-1">
						<h2 class="font-display text-h5 text-strong">{r.name}</h2>
						{#if r.description}
							<p class="mt-0.5 text-sm text-subtle">{r.description}</p>
						{/if}
						<div class="mt-2 flex flex-wrap items-center gap-1.5">
							<span class={triggerBadge(r.trigger.kind)}>{triggerLabel(r.trigger)}</span>
							<span class="badge {r.enabled ? 'badge-green' : 'badge-neutral'}">
								<span class="inline-block h-1.5 w-1.5 rounded-full"
									style={`background:${r.enabled ? '#29A745' : '#999'}`}></span>
								{r.enabled ? "enabled" : "disabled"}
							</span>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<button class="btn-secondary btn-sm" on:click={() => toggleEnabled(r)}>
							{r.enabled ? "Disable" : "Enable"}
						</button>
						<button class="btn-secondary btn-sm" on:click={() => runNow(r.id)}>
							<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
							Run now
						</button>
					</div>
				</div>
			</li>
		{/each}
	</ul>
{/if}
