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

	onMount(load);
</script>

<header class="flex items-center justify-between">
	<div>
		<h1 class="text-xl font-semibold">Clients</h1>
		<p class="mt-1 text-sm text-zinc-500">
			Each Client is an umbrella over the channels, chats, SharePoint sites, and Planner plans
			that belong to one engagement. Arcadia keeps rolling memory inside that umbrella.
		</p>
	</div>
	<a class="btn" href="/clients/new">+ New Client</a>
</header>

{#if loading}
	<p class="mt-6 text-sm text-zinc-500">Loading…</p>
{:else if error}
	<p class="mt-6 text-sm text-red-500">Error: {error}</p>
{:else if clients.length === 0}
	<div class="mt-6 rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
		No Clients defined yet. <a class="underline" href="/clients/new">Create the first one</a>
		so Arcadia can ground client-specific questions instead of answering in agency mode.
	</div>
{:else}
	<ul class="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
		{#each clients as c}
			<li class="flex items-center justify-between gap-3 py-3">
				<div class="min-w-0 flex-1">
					<a href={`/clients/${c.id}`} class="block">
						<div class="flex items-center gap-2">
							<span class="inline-block h-2.5 w-2.5 rounded-full" style={`background:${c.color}`}></span>
							<span class="truncate font-medium">{c.name}</span>
						</div>
						{#if c.description}
							<div class="mt-0.5 truncate text-sm text-zinc-500">{c.description}</div>
						{/if}
						<div class="mt-1 flex items-center gap-2 text-xs text-zinc-500">
							<span class="chip">index: {c.indexStatus}</span>
							<span>last indexed {fmtDate(c.indexCompletedAt)}</span>
						</div>
					</a>
				</div>
				<a class="btn" href={`/clients/${c.id}`}>Manage</a>
			</li>
		{/each}
	</ul>
{/if}
