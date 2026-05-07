<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/stores";
	import { goto } from "$app/navigation";
	import {
		loadTeams, loadChannels, loadChats, loadSharePoint, loadPlannerPlans,
		chatLabel, attachSource, detachSource,
		type UserTeam, type UserChannel, type UserChat, type SharePointSite, type PlannerPlan,
		type ClientSourceType,
	} from "$lib/client-source-picker";

	interface Client {
		id: string;
		name: string;
		description: string | null;
		color: string;
		indexStatus: string;
		indexCompletedAt: string | null;
	}
	interface ClientSource {
		id: string;
		clientId: string;
		sourceType: ClientSourceType;
		sourceId: string;
		sourceName: string;
		teamId: string | null;
	}

	let clientId = "";
	let client: Client | null = null;
	let sources: ClientSource[] = [];
	let loading = true;
	let error = "";

	let showAdd = false;
	let saving = false;

	let teams: UserTeam[] = [];
	let channelsByTeam: Record<string, UserChannel[]> = {};
	let expandedTeams = new Set<string>();
	let chats: UserChat[] = [];
	let sites: SharePointSite[] = [];
	let plans: PlannerPlan[] = [];

	$: clientId = $page.params.id ?? "";

	async function load() {
		loading = true;
		error = "";
		try {
			const [c, s] = await Promise.all([
				fetch(`/api/webapp/clients/${clientId}`, { credentials: "include" }).then((r) => r.json()),
				fetch(`/api/webapp/clients/${clientId}/sources`, { credentials: "include" }).then((r) => r.json()),
			]);
			client = c.client as Client;
			sources = (s.sources ?? []) as ClientSource[];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function openAdd() {
		showAdd = true;
		// Lazy-load the option lists once.
		if (teams.length === 0) {
			try { teams = await loadTeams(); } catch (e) { error = `Teams: ${(e as Error).message}`; }
		}
		if (chats.length === 0) {
			try { chats = await loadChats(); } catch (e) { error = `Chats: ${(e as Error).message}`; }
		}
		if (sites.length === 0) {
			try { sites = await loadSharePoint(); } catch (e) { error = `SharePoint: ${(e as Error).message}`; }
		}
		if (plans.length === 0) {
			try { plans = await loadPlannerPlans(); } catch (e) { error = `Planner: ${(e as Error).message}`; }
		}
	}

	function isAttached(sourceType: ClientSourceType, sourceId: string): boolean {
		return sources.some((s) => s.sourceType === sourceType && s.sourceId === sourceId);
	}

	async function toggleTeam(t: UserTeam) {
		if (expandedTeams.has(t.id)) {
			expandedTeams.delete(t.id);
			expandedTeams = expandedTeams;
			return;
		}
		expandedTeams.add(t.id);
		expandedTeams = expandedTeams;
		if (!channelsByTeam[t.id]) {
			try {
				channelsByTeam[t.id] = await loadChannels(t.id);
				channelsByTeam = channelsByTeam;
			} catch (e) {
				error = `Channels for ${t.displayName}: ${(e as Error).message}`;
			}
		}
	}

	async function attachChannel(t: UserTeam, ch: UserChannel) {
		saving = true;
		try {
			await attachSource(clientId, {
				sourceType: "channel",
				sourceId: ch.id,
				sourceName: `${t.displayName} › ${ch.displayName}`,
				teamId: t.id,
				metadata: { teamName: t.displayName, channelName: ch.displayName },
			});
			await load();
		} catch (e) { error = (e as Error).message; }
		finally { saving = false; }
	}
	async function attachChat(c: UserChat) {
		saving = true;
		try { await attachSource(clientId, { sourceType: "chat", sourceId: c.id, sourceName: chatLabel(c) }); await load(); }
		catch (e) { error = (e as Error).message; }
		finally { saving = false; }
	}
	async function attachSite(s: SharePointSite) {
		saving = true;
		try { await attachSource(clientId, { sourceType: "sharepoint-site", sourceId: s.id, sourceName: s.displayName }); await load(); }
		catch (e) { error = (e as Error).message; }
		finally { saving = false; }
	}
	async function attachPlan(p: PlannerPlan) {
		saving = true;
		try { await attachSource(clientId, { sourceType: "planner-plan", sourceId: p.id, sourceName: p.title }); await load(); }
		catch (e) { error = (e as Error).message; }
		finally { saving = false; }
	}

	async function remove(rowId: string) {
		if (!confirm("Detach this source from the client? Memories already extracted are kept.")) return;
		try { await detachSource(clientId, rowId); await load(); }
		catch (e) { error = (e as Error).message; }
	}

	async function reindex() {
		const res = await fetch(`/api/webapp/clients/${clientId}/index`, {
			method: "POST", credentials: "include",
		});
		if (!res.ok) { error = `Re-index failed: HTTP ${res.status}`; return; }
		await load();
	}

	async function deleteClient() {
		if (!client) return;
		if (!confirm(`Delete "${client.name}"? Removes all bindings, memories, and notifications. The M365 surfaces themselves are untouched.`)) return;
		const res = await fetch(`/api/webapp/clients/${clientId}`, {
			method: "DELETE", credentials: "include",
		});
		if (!res.ok) { error = `Delete failed: HTTP ${res.status}`; return; }
		await goto("/clients");
	}

	onMount(load);

	function groupCount(t: ClientSourceType): number {
		return sources.filter((s) => s.sourceType === t).length;
	}
</script>

{#if loading}
	<p class="mt-6 text-sm text-zinc-500">Loading…</p>
{:else if error && !client}
	<p class="mt-6 text-sm text-red-500">Error: {error}</p>
{:else if client}
	<header class="flex items-start justify-between gap-4">
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<span class="inline-block h-3 w-3 rounded-full" style={`background:${client.color}`}></span>
				<h1 class="truncate text-xl font-semibold">{client.name}</h1>
			</div>
			{#if client.description}
				<p class="mt-1 text-sm text-zinc-500">{client.description}</p>
			{/if}
			<div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
				<span class="chip">index: {client.indexStatus}</span>
				<span class="chip">channels: {groupCount("channel")}</span>
				<span class="chip">chats: {groupCount("chat")}</span>
				<span class="chip">sites: {groupCount("sharepoint-site")}</span>
				<span class="chip">plans: {groupCount("planner-plan")}</span>
			</div>
		</div>
		<div class="flex shrink-0 gap-2">
			<button class="btn" on:click={reindex}>Re-index</button>
			<button class="btn" on:click={deleteClient}>Delete</button>
		</div>
	</header>

	<section class="mt-6">
		<header class="flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Bound sources</h2>
			<button class="btn" on:click={() => (showAdd ? (showAdd = false) : openAdd())}>
				{showAdd ? "Done" : "+ Add sources"}
			</button>
		</header>

		{#if sources.length === 0}
			<p class="mt-3 text-sm text-zinc-500">
				No bindings yet. Click <strong>Add sources</strong> to pick channels, chats, SharePoint sites, or Planner plans
				that belong to this client.
			</p>
		{:else}
			<ul class="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">
				{#each sources as s}
					<li class="flex items-center justify-between gap-3 py-2">
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{s.sourceName}</div>
							<div class="text-xs text-zinc-500">{s.sourceType}{s.teamId ? ` · team ${s.teamId.slice(0, 8)}…` : ""}</div>
						</div>
						<button class="btn" on:click={() => remove(s.id)}>Detach</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if showAdd}
		<section class="mt-6 space-y-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
			<header>
				<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Add bindings</h2>
				<p class="text-xs text-zinc-500">Click any item to attach it. Already-attached items are dimmed.</p>
			</header>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Teams channels</h3>
				<ul class="mt-1 space-y-1">
					{#each teams as t}
						<li>
							<button type="button" class="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
								on:click={() => toggleTeam(t)}>
								<span class="font-medium">{t.displayName}</span>
								<span class="text-xs text-zinc-500">{expandedTeams.has(t.id) ? "−" : "+"}</span>
							</button>
							{#if expandedTeams.has(t.id)}
								<ul class="ml-4 mt-1 space-y-1">
									{#if !channelsByTeam[t.id]}
										<li class="text-xs text-zinc-500">Loading…</li>
									{:else}
										{#each channelsByTeam[t.id] as ch}
											<li>
												<button type="button" class="block w-full rounded px-2 py-0.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
													disabled={saving || isAttached("channel", ch.id)}
													on:click={() => attachChannel(t, ch)}>
													#{ch.displayName} {isAttached("channel", ch.id) ? "(attached)" : ""}
												</button>
											</li>
										{/each}
									{/if}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			</div>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Chats</h3>
				<ul class="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
					{#each chats as c}
						<li>
							<button type="button" class="block w-full rounded px-2 py-0.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
								disabled={saving || isAttached("chat", c.id)}
								on:click={() => attachChat(c)}>
								{chatLabel(c)} <span class="text-xs text-zinc-500">({c.chatType})</span> {isAttached("chat", c.id) ? "(attached)" : ""}
							</button>
						</li>
					{/each}
				</ul>
			</div>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-zinc-500">SharePoint sites</h3>
				<ul class="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
					{#each sites as s}
						<li>
							<button type="button" class="block w-full rounded px-2 py-0.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
								disabled={saving || isAttached("sharepoint-site", s.id)}
								on:click={() => attachSite(s)}>
								{s.displayName} {isAttached("sharepoint-site", s.id) ? "(attached)" : ""}
							</button>
						</li>
					{/each}
				</ul>
			</div>

			<div>
				<h3 class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Planner plans</h3>
				<ul class="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
					{#each plans as p}
						<li>
							<button type="button" class="block w-full rounded px-2 py-0.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
								disabled={saving || isAttached("planner-plan", p.id)}
								on:click={() => attachPlan(p)}>
								{p.title} {isAttached("planner-plan", p.id) ? "(attached)" : ""}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</section>
	{/if}

	{#if error}
		<p class="mt-4 text-sm text-red-500">{error}</p>
	{/if}
{/if}
