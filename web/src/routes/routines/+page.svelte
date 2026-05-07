<script lang="ts">
	import { onMount } from "svelte";

	interface Routine {
		id: string;
		name: string;
		description: string | null;
		trigger: { kind: string; expr?: string };
		enabled: boolean;
		lastRunAt: number | null;
	}

	let routines: Routine[] = [];
	let error = "";
	let loading = true;

	onMount(async () => {
		try {
			const res = await fetch("/api/webapp/routines", { credentials: "include" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			routines = (await res.json()) as Routine[];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	});

	async function runNow(id: string) {
		const res = await fetch(`/api/webapp/routines/${id}/run`, { method: "POST", credentials: "include" });
		if (!res.ok) {
			alert(`Failed: ${res.status}`);
			return;
		}
		const out = await res.json();
		alert(`Status: ${out.status}\nSteps: ${out.results?.length ?? 0}`);
	}
</script>

<h1 class="text-xl font-semibold">Routines</h1>
<p class="mt-1 text-sm text-zinc-500">
	Saved automations that run on a schedule, on Graph events, or on chat intent.
</p>

{#if loading}
	<p class="mt-6 text-sm text-zinc-500">Loading…</p>
{:else if error}
	<p class="mt-6 text-sm text-red-500">Error: {error}</p>
{:else if routines.length === 0}
	<p class="mt-6 text-sm text-zinc-500">No routines yet. The visual builder is on the way.</p>
{:else}
	<ul class="mt-6 space-y-3">
		{#each routines as r}
			<li class="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
				<header class="flex items-center justify-between">
					<div>
						<div class="font-medium">{r.name}</div>
						{#if r.description}
							<div class="text-xs text-zinc-500">{r.description}</div>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						<span class="chip">{r.trigger.kind}{r.trigger.expr ? ` · ${r.trigger.expr}` : ""}</span>
						<span class="chip">{r.enabled ? "enabled" : "disabled"}</span>
						<button class="btn" on:click={() => runNow(r.id)}>Run now</button>
					</div>
				</header>
			</li>
		{/each}
	</ul>
{/if}
