<script lang="ts">
	import { onMount } from "svelte";
	import { api } from "$lib/api";
	import type { IngestSourceStatus, Source, SourcesData } from "$lib/types";

	// Producers that run on the */15 cron tick (src/runtime/cron-dispatcher.ts,
	// case "*/15 * * * *" -> produceAll()). 'registry' runs on the 6h cron and
	// 'consumer' drains the queue continuously — neither has a 15-minute SLA,
	// so the staleness rule below only applies to this set.
	const FIFTEEN_MIN_CRON_SOURCES = new Set([
		"messages",
		"drives",
		"sharepoint",
		"mail",
		"calendar",
		"meetings",
	]);
	const STALE_MS = 2 * 3600 * 1000;

	let data: SourcesData | null = null;
	let loading = true;
	let error = "";

	// The backend always returns one entry per known ingest source for
	// admins, and `[]` for non-admins (src/webapp/sources-api.ts) — so an
	// empty array here means this session isn't seeing ingest/delta detail,
	// not that nothing has run yet.
	$: adminDetail = (data?.ingest.length ?? 0) > 0;

	async function load() {
		loading = true;
		error = "";
		try {
			data = await api.sources(200);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function forget(id: string) {
		if (!confirm("Forget this source from Arcadia? It can be re-indexed on the next sync.")) return;
		try {
			await api.forgetSource(id);
			if (data) data = { ...data, sources: data.sources.filter((s) => s.id !== id) };
		} catch (e) {
			alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	function fmtSize(n: number | null): string {
		if (!n) return "";
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function fmtUnix(unix: number): string {
		try { return new Date(unix * 1000).toLocaleString(); } catch { return ""; }
	}

	function fmtIso(iso: string | null | undefined): string {
		if (!iso) return "—";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	function typeBadge(t: string): string {
		const lc = t.toLowerCase();
		if (lc.includes("channel"))     return "badge badge-blue";
		if (lc.includes("chat"))        return "badge badge-violet";
		if (lc.includes("sharepoint"))  return "badge badge-cyan";
		if (lc.includes("drive"))       return "badge badge-cyan";
		if (lc.includes("mail"))        return "badge badge-amber";
		if (lc.includes("meeting") || lc.includes("calendar")) return "badge badge-green";
		if (lc.includes("planner"))     return "badge badge-amber";
		return "badge badge-neutral";
	}

	function isStale(status: IngestSourceStatus): boolean {
		if (!FIFTEEN_MIN_CRON_SOURCES.has(status.source)) return false;
		const finishedAt = status.latest?.finishedAt;
		if (!finishedAt) return true;
		return Date.now() - new Date(finishedAt).getTime() > STALE_MS;
	}

	function statusBadge(status: IngestSourceStatus): string {
		if (!status.latest) return "badge badge-neutral";
		if (status.latest.failures > 0) return "badge badge-red";
		if (isStale(status)) return "badge badge-amber";
		return "badge badge-green";
	}

	function statusLabel(status: IngestSourceStatus): string {
		if (!status.latest) return "no runs yet";
		if (isStale(status)) return "stale";
		if (status.latest.failures > 0) return "failing";
		return "fresh";
	}

	onMount(load);
</script>

<header class="flex items-start justify-between gap-4">
	<div>
		<p class="section-eyebrow">Index</p>
		<h1 class="font-display text-h2 text-strong">Sources</h1>
		<p class="mt-2 max-w-prose-tight text-sm text-subtle">
			What Arcadia is ingesting, how fresh it is, and what she's indexed. <strong>Forget</strong>
			removes a source from search; the underlying artifact in M365 is unaffected.
		</p>
	</div>
	<button class="btn-secondary" on:click={load}>
		<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.51-7.13M21 4v5h-5"/></svg>
		Refresh
	</button>
</header>

{#if loading}
	<div class="mt-6 flex items-center gap-2 text-sm text-subtle" role="status">
		<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
		<span class="ml-1">Loading sources…</span>
	</div>
{:else if error}
	<div class="banner banner-danger mt-6"><div><strong>Error.</strong> {error}</div></div>
{:else if data}
	<!-- Ingest cycle health -->
	<section class="mt-6">
		<h2 class="font-display text-h4 text-strong">Ingest cycles</h2>
		{#if !adminDetail}
			<p class="mt-1 text-sm text-subtle">Ingest cycle detail is admin-only.</p>
		{:else}
			<div class="mt-3 surface overflow-hidden">
				<div class="grid grid-cols-6 gap-2 border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide text-subtle" style="border-color: var(--line-hairline);">
					<span>Source</span>
					<span>Status</span>
					<span>Last run</span>
					<span>Last run counts</span>
					<span>24h totals</span>
					<span>24h runs</span>
				</div>
				<ul class="divide-y" style="border-color: var(--line-hairline);">
					{#each data.ingest as s (s.source)}
						<li class="grid grid-cols-6 items-center gap-2 px-4 py-3 text-sm">
							<span class="font-medium text-strong">{s.source}</span>
							<span><span class={statusBadge(s)}>{statusLabel(s)}</span></span>
							<span class="text-subtle">
								{#if s.latest}
									started {fmtIso(s.latest.startedAt)}<br />
									finished {fmtIso(s.latest.finishedAt)}
								{:else}
									—
								{/if}
							</span>
							<span class="text-subtle">
								{#if s.latest}
									{s.latest.enqueued} enq · {s.latest.processed} proc
									{#if s.latest.failures > 0}<span class="text-danger">· {s.latest.failures} fail</span>{/if}
								{:else}
									—
								{/if}
							</span>
							<span class="text-subtle">
								{s.last24h.enqueued} enq · {s.last24h.processed} proc
								{#if s.last24h.failures > 0}<span class="text-danger">· {s.last24h.failures} fail</span>{/if}
							</span>
							<span class="text-subtle">{s.last24h.runs}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>

	<!-- Document freshness per source -->
	<section class="mt-6">
		<h2 class="font-display text-h4 text-strong">Freshness</h2>
		{#if data.freshness.length === 0}
			<p class="mt-1 text-sm text-subtle">Nothing indexed yet.</p>
		{:else}
			<div class="mt-3 surface overflow-hidden">
				<div class="grid grid-cols-3 gap-2 border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide text-subtle" style="border-color: var(--line-hairline);">
					<span>Source</span>
					<span>Documents</span>
					<span>Latest indexed</span>
				</div>
				<ul class="divide-y" style="border-color: var(--line-hairline);">
					{#each data.freshness as f (f.source)}
						<li class="grid grid-cols-3 items-center gap-2 px-4 py-3 text-sm">
							<span class={typeBadge(f.source)}>{f.source}</span>
							<span class="text-strong">{f.count}</span>
							<span class="text-subtle">{fmtIso(f.latestIndexedAt)}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>

	<!-- Delta-sync watermarks -->
	{#if adminDetail}
		<section class="mt-6">
			<h2 class="font-display text-h4 text-strong">Delta sync watermarks</h2>
			{#if data.deltaState.length === 0}
				<p class="mt-1 text-sm text-subtle">No delta cursors recorded yet.</p>
			{:else}
				<div class="mt-3 surface overflow-hidden">
					<div class="grid grid-cols-3 gap-2 border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide text-subtle" style="border-color: var(--line-hairline);">
						<span>Resource</span>
						<span>Scopes tracked</span>
						<span>Last sync</span>
					</div>
					<ul class="divide-y" style="border-color: var(--line-hairline);">
						{#each data.deltaState as d (d.resource)}
							<li class="grid grid-cols-3 items-center gap-2 px-4 py-3 text-sm">
								<span class="font-medium text-strong">{d.resource}</span>
								<span class="text-strong">{d.count}</span>
								<span class="text-subtle">{fmtIso(d.lastRunAt)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Indexed documents -->
	<section class="mt-6">
		<h2 class="font-display text-h4 text-strong">Indexed documents</h2>
		{#if data.sources.length === 0}
			<div class="empty mt-3">
				<p class="font-display text-h4 text-strong">Nothing indexed yet</p>
				<p class="mt-1 text-sm text-subtle">
					The 15-minute cron walks <span class="kbd">delta_state</span> per resource; data shows up once the
					producers have run at least once.
				</p>
			</div>
		{:else}
			<div class="mt-3 surface overflow-hidden">
				<ul class="divide-y" style="border-color: var(--line-hairline);">
					{#each data.sources as s (s.id)}
						<li class="flex items-start justify-between gap-4 px-4 py-3 hover:bg-recessed transition-colors duration-150">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<h3 class="truncate font-medium text-strong">
										{s.title ?? `(untitled ${s.resourceType})`}
									</h3>
								</div>
								<div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
									<span class={typeBadge(s.resourceType)}>{s.resourceType}</span>
									{#if s.mimeType}<span class="badge badge-neutral">{s.mimeType}</span>{/if}
									{#if s.sensitivityLabel}<span class="badge badge-amber">label: {s.sensitivityLabel}</span>{/if}
									{#if s.sizeBytes}<span>{fmtSize(s.sizeBytes)}</span>{/if}
									<span aria-hidden="true">·</span>
									<span>updated {fmtUnix(s.updatedAt)}</span>
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								{#if s.uri}
									<a class="btn-secondary btn-sm" href={s.uri} target="_blank" rel="noopener">
										<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/></svg>
										Open
									</a>
								{/if}
								<button class="btn-ghost btn-sm" on:click={() => forget(s.id)}>Forget</button>
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>
{/if}
