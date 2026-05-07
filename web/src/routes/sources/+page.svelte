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

	onMount(load);
</script>

<header class="flex items-center justify-between">
	<div>
		<h1 class="text-xl font-semibold">Sources</h1>
		<p class="mt-1 text-sm text-zinc-500">
			What Arcadia has indexed and is allowed to show you. "Forget" removes it from search;
			the source artifact in M365 is unaffected.
		</p>
	</div>
	<button class="btn" on:click={load}>Refresh</button>
</header>

{#if loading}
	<p class="mt-6 text-sm text-zinc-500">Loading…</p>
{:else if error}
	<p class="mt-6 text-sm text-red-500">Error: {error}</p>
{:else if sources.length === 0}
	<p class="mt-6 text-sm text-zinc-500">
		No sources yet. The hourly cron walks delta_state per user; data shows up once the producers
		have run at least once.
	</p>
{:else}
	<ul class="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
		{#each sources as s}
			<li class="flex items-center justify-between gap-3 py-3">
				<div class="min-w-0 flex-1">
					<div class="truncate font-medium">{s.title ?? `(untitled ${s.resourceType})`}</div>
					<div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
						<span class="chip">{s.resourceType}</span>
						{#if s.mimeType}<span class="chip">{s.mimeType}</span>{/if}
						{#if s.sensitivityLabel}<span class="chip">label: {s.sensitivityLabel}</span>{/if}
						{#if s.sizeBytes}<span>{fmtSize(s.sizeBytes)}</span>{/if}
						<span>· updated {fmtDate(s.updatedAt)}</span>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					{#if s.uri}
						<a class="btn" href={s.uri} target="_blank" rel="noopener">Open</a>
					{/if}
					<button class="btn" on:click={() => forget(s.id)}>Forget</button>
				</div>
			</li>
		{/each}
	</ul>
{/if}
