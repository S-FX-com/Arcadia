<script lang="ts">
	import { onMount } from "svelte";
	import { api } from "$lib/api";
	import type { DashboardData } from "$lib/types";

	let data: DashboardData | null = null;
	let error: string | null = null;
	let loading = true;

	onMount(async () => {
		try {
			data = await api.dashboard();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
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
		<p class="section-eyebrow">Today</p>
		<h1 class="font-display text-h2 text-strong">Dashboard</h1>
	</header>

	{#if loading}
		<p class="text-sm text-subtle">Loading…</p>
	{:else if error}
		<div class="rounded-s border border-hairline bg-elevated p-4 text-sm text-strong">
			<p class="font-semibold">Could not load dashboard.</p>
			<p class="mt-1 text-subtle">{error}</p>
		</div>
	{:else if data}
		<div class="grid grid-cols-1 gap-4 md:grid-cols-4">
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Open</p>
				<p class="text-2xl font-display text-strong">{data.tasks.open}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">In progress</p>
				<p class="text-2xl font-display text-strong">{data.tasks.inProgress}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Blocked</p>
				<p class="text-2xl font-display text-strong">{data.tasks.blocked}</p>
			</div>
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">Total open</p>
				<p class="text-2xl font-display text-strong">{data.tasks.total}</p>
			</div>
		</div>

		<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<h2 class="mb-3 font-display text-h4 text-strong">Due today</h2>
				{#if data.dueToday.length === 0}
					<p class="text-sm text-subtle">Nothing due today.</p>
				{:else}
					<ul class="space-y-2 text-sm">
						{#each data.dueToday as t (t.id)}
							<li class="flex items-start justify-between gap-2">
								<span class="text-strong">{t.title}</span>
								<span class="text-subtle whitespace-nowrap">{fmtDate(t.deadlineAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rounded-s border border-hairline bg-elevated p-4">
				<h2 class="mb-3 font-display text-h4 text-strong">Overdue</h2>
				{#if data.overdue.length === 0}
					<p class="text-sm text-subtle">Nothing overdue.</p>
				{:else}
					<ul class="space-y-2 text-sm">
						{#each data.overdue as t (t.id)}
							<li class="flex items-start justify-between gap-2">
								<span class="text-strong">{t.title}</span>
								<span class="text-subtle whitespace-nowrap">{fmtDate(t.deadlineAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		<div class="grid grid-cols-1 gap-6 md:grid-cols-2">
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<h2 class="mb-3 font-display text-h4 text-strong">Recent digests</h2>
				{#if data.recentDigests.length === 0}
					<p class="text-sm text-subtle">No digests yet.</p>
				{:else}
					<ul class="space-y-2 text-sm">
						{#each data.recentDigests as d (d.id)}
							<li class="flex items-start justify-between gap-2">
								<span class="text-strong">{d.channelDisplayName ?? d.channelId}</span>
								<span class="text-subtle whitespace-nowrap">{fmtDate(d.postedAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rounded-s border border-hairline bg-elevated p-4">
				<h2 class="mb-3 font-display text-h4 text-strong">Active routines</h2>
				{#if data.activeRoutines.length === 0}
					<p class="text-sm text-subtle">No active routines.</p>
				{:else}
					<ul class="space-y-2 text-sm">
						{#each data.activeRoutines as r (r.id)}
							<li class="flex items-start justify-between gap-2">
								<a class="text-strong hover:underline" href="/routines">{r.name}</a>
								<span class="text-subtle text-xs">{r.trigger.kind}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		{#if data.latestBrief}
			<div class="rounded-s border border-hairline bg-elevated p-4">
				<p class="section-eyebrow">{data.latestBrief.kind} brief</p>
				<p class="mt-2 whitespace-pre-wrap text-sm text-strong">{data.latestBrief.body}</p>
				<p class="mt-2 text-xs text-subtle">{fmtDate(data.latestBrief.posted_at)}</p>
			</div>
		{/if}
	{/if}
</section>
