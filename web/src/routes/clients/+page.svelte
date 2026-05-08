<script lang="ts">
	import { onMount } from "svelte";

	interface Client {
		id: string;
		name: string;
		description: string | null;
		color: string;
		indexStatus: string;
		indexCompletedAt: string | null;
	}

	let clients: Client[] = [];
	let loading = true;
	let error = "";

	async function load() {
		loading = true;
		error = "";
		try {
			const res = await fetch("/api/webapp/clients", { credentials: "include" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			clients = (body.clients ?? []) as Client[];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return "never";
		try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
	}

	function statusBadge(status: string): string {
		const s = status.toLowerCase();
		if (s === "ready" || s === "complete" || s === "completed") return "badge badge-green";
		if (s === "indexing" || s === "running" || s === "pending")  return "badge badge-amber";
		if (s === "failed"  || s === "error")                        return "badge badge-red";
		return "badge badge-neutral";
	}

	onMount(load);
</script>

<header class="flex items-start justify-between gap-4">
	<div>
		<p class="section-eyebrow">Workspace</p>
		<h1 class="font-display text-h2 text-strong">Clients</h1>
		<p class="mt-2 max-w-prose-tight text-sm text-subtle">
			Each Client is an umbrella over the channels, chats, SharePoint sites, and Planner plans
			that belong to one engagement. Arcadia keeps rolling memory inside that umbrella.
		</p>
	</div>
	<a class="btn-primary" href="/clients/new">
		<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
		New client
	</a>
</header>

{#if loading}
	<div class="mt-6 flex items-center gap-2 text-sm text-subtle" role="status">
		<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
		<span class="ml-1">Loading clients…</span>
	</div>
{:else if error}
	<div class="banner banner-danger mt-6">
		<svg class="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
		<div><strong>Couldn't load clients.</strong> {error}</div>
	</div>
{:else if clients.length === 0}
	<div class="empty mt-6">
		<p class="font-display text-h4 text-strong">No clients yet</p>
		<p class="mt-1 text-sm text-subtle">
			Create the first one so Arcadia can ground client-specific questions instead of
			answering in agency mode.
		</p>
		<a class="btn-primary mt-4" href="/clients/new">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
			Create the first client
		</a>
	</div>
{:else}
	<ul class="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
		{#each clients as c}
			<li class="surface-card hover:shadow-box-l transition-shadow duration-150">
				<a href={`/clients/${c.id}`} class="block">
					<div class="flex items-start gap-3">
						<span
							class="mt-1 inline-block h-3 w-3 shrink-0 rounded-full ring-2 ring-white shadow-box-m"
							style={`background:${c.color}`}
						></span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center justify-between gap-3">
								<h2 class="font-display text-h5 text-strong truncate">{c.name}</h2>
								<span class={statusBadge(c.indexStatus)}>{c.indexStatus}</span>
							</div>
							{#if c.description}
								<p class="mt-1 text-sm text-subtle line-clamp-2">{c.description}</p>
							{/if}
							<div class="mt-3 flex items-center gap-3 text-xs text-subtle">
								<span>Last indexed {fmtDate(c.indexCompletedAt)}</span>
								<span aria-hidden="true">·</span>
								<span class="text-link">Manage →</span>
							</div>
						</div>
					</div>
				</a>
			</li>
		{/each}
	</ul>
{/if}
