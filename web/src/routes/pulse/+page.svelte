<script lang="ts">
	import { onMount } from "svelte";
	import { api } from "$lib/api";
	import type { OrgPulse } from "$lib/types";

	let data: OrgPulse | null = null;
	let error: string | null = null;
	let forbidden = false;
	let loading = true;

	onMount(async () => {
		try {
			data = await api.orgPulse();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("403")) forbidden = true;
			else error = msg;
		} finally {
			loading = false;
		}
	});

	function fmtDate(iso?: string): string {
		if (!iso) return "—";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}
</script>

<section class="space-y-6">
	<header>
		<p class="section-eyebrow">Right now</p>
		<h1 class="font-display text-h2 text-strong">Org pulse</h1>
	</header>

	{#if loading}
		<p class="text-sm text-subtle">Loading…</p>
	{:else if forbidden}
		<div class="rounded-s border border-hairline bg-elevated p-4 text-sm text-strong">
			<p class="font-semibold">Admins only.</p>
			<p class="mt-1 text-subtle">
				The org pulse aggregates activity across the whole tenant, so it's
				limited to admins.
			</p>
		</div>
	{:else if error}
		<div class="rounded-s border border-hairline bg-elevated p-4 text-sm text-strong">
			<p class="font-semibold">Could not load the org pulse.</p>
			<p class="mt-1 text-subtle">{error}</p>
		</div>
	{:else if data}
		{#if data.summary}
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Summary</p>
				<p class="mt-2 whitespace-pre-wrap text-sm text-strong">{data.summary}</p>
				<p class="mt-2 text-xs text-subtle">Generated {fmtDate(data.generatedAt)}</p>
			</div>
		{/if}

		<div class="grid grid-cols-2 gap-4 md:grid-cols-5">
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Workstreams</p>
				<p class="text-2xl font-display text-strong">{data.counts.activeWorkstreams}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Decisions</p>
				<p class="text-2xl font-display text-strong">{data.counts.decisionsInFlight}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Stalled</p>
				<p class="text-2xl font-display text-strong">{data.counts.stalledThreads}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">At risk</p>
				<p class="text-2xl font-display text-strong">{data.counts.atRiskTasks}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Silences</p>
				<p class="text-2xl font-display text-strong">{data.counts.unusualSilences}</p>
			</div>
		</div>

		{#if data.sections.length === 0}
			<p class="text-sm text-subtle">Nothing notable across the org right now.</p>
		{:else}
			<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
				{#each data.sections as s (s.title)}
					<div class="rounded-s border border-hairline bg-elevated p-4">
						<h2 class="mb-3 font-display text-h4 text-strong">{s.title}</h2>
						{#if s.bullets.length === 0}
							<p class="text-sm text-subtle">Nothing here.</p>
						{:else}
							<ul class="space-y-2 text-sm">
								{#each s.bullets as b (b)}
									<li class="text-strong">{b}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</section>
