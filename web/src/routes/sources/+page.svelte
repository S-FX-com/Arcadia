<script lang="ts">
	import { onMount } from "svelte";

	interface Source {
		id: string;
		resourceType: string;
		resourceId: string;
		title: string | null;
		uri: string | null;
		mimeType: string | null;
		sizeBytes: number | null;
		sensitivityLabel: string | null;
		updatedAt: number;
	}

	let sources: Source[] = [];
	let loading = true;
	let error = "";

	async function load() {
		loading = true;
		error = "";
		try {
			const res = await fetch("/api/webapp/sources?limit=200", { credentials: "include" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			sources = (body.sources ?? []) as Source[];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function forget(id: string) {
		if (!confirm("Forget this source from Arcadia? It can be re-indexed on the next sync.")) return;
		const res = await fetch(`/api/webapp/sources/${id}`, { method: "DELETE", credentials: "include" });
		if (!res.ok) {
			alert(`Failed: ${res.status}`);
			return;
		}
		sources = sources.filter((s) => s.id !== id);
	}

	function fmtSize(n: number | null): string {
		if (!n) return "";
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function fmtDate(unix: number): string {
		try { return new Date(unix * 1000).toLocaleString(); } catch { return ""; }
	}

	function typeBadge(t: string): string {
		const lc = t.toLowerCase();
		if (lc.includes("channel"))     return "badge badge-blue";
		if (lc.includes("chat"))        return "badge badge-violet";
		if (lc.includes("sharepoint"))  return "badge badge-cyan";
		if (lc.includes("planner"))     return "badge badge-amber";
		return "badge badge-neutral";
	}

	onMount(load);
</script>

<header class="flex items-start justify-between gap-4">
	<div>
		<p class="section-eyebrow">Index</p>
		<h1 class="font-display text-h2 text-strong">Sources</h1>
		<p class="mt-2 max-w-prose-tight text-sm text-subtle">
			What Arcadia has indexed and is allowed to show you. <strong>Forget</strong> removes a source from search;
			the underlying artifact in M365 is unaffected.
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
{:else if sources.length === 0}
	<div class="empty mt-6">
		<p class="font-display text-h4 text-strong">Nothing indexed yet</p>
		<p class="mt-1 text-sm text-subtle">
			The hourly cron walks <span class="kbd">delta_state</span> per user; data shows up once the
			producers have run at least once.
		</p>
	</div>
{:else}
	<div class="mt-6 surface overflow-hidden">
		<ul class="divide-y" style="--tw-divide-opacity: 1; border-color: var(--line-hairline);">
			{#each sources as s}
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
							<span>updated {fmtDate(s.updatedAt)}</span>
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
