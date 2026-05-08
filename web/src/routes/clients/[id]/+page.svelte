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

	function statusBadge(status: string): string {
		const s = status.toLowerCase();
		if (s === "ready" || s === "complete" || s === "completed") return "badge badge-green";
		if (s === "indexing" || s === "running" || s === "pending")  return "badge badge-amber";
		if (s === "failed"  || s === "error")                        return "badge badge-red";
		return "badge badge-neutral";
	}

	function typeBadge(t: ClientSourceType): string {
		switch (t) {
			case "channel":         return "badge badge-blue";
			case "chat":            return "badge badge-violet";
			case "sharepoint-site": return "badge badge-cyan";
			case "planner-plan":    return "badge badge-amber";
			default:                return "badge badge-neutral";
		}
	}
</script>

{#if loading}
	<div class="flex items-center gap-2 text-sm text-subtle" role="status">
		<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
		<span class="ml-1">Loading client…</span>
	</div>
{:else if error && !client}
	<div class="banner banner-danger"><div><strong>Error.</strong> {error}</div></div>
{:else if client}
	<!-- Hero -->
	<header class="surface-card relative overflow-hidden">
		<div
			class="absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-15 blur-2xl"
			style={`background:${client.color}`}
			aria-hidden="true"
		></div>
		<div class="relative flex items-start justify-between gap-4">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-3">
					<span class="inline-block h-4 w-4 rounded-full ring-2 ring-white shadow-box-m" style={`background:${client.color}`}></span>
					<p class="section-eyebrow">Client</p>
				</div>
				<h1 class="mt-1 font-display text-h2 text-strong truncate">{client.name}</h1>
				{#if client.description}
					<p class="mt-1 max-w-prose-tight text-sm text-subtle">{client.description}</p>
				{/if}
				<div class="mt-3 flex flex-wrap items-center gap-1.5">
					<span class={statusBadge(client.indexStatus)}>index: {client.indexStatus}</span>
					<span class="badge badge-blue">channels: {groupCount("channel")}</span>
					<span class="badge badge-violet">chats: {groupCount("chat")}</span>
					<span class="badge badge-cyan">sites: {groupCount("sharepoint-site")}</span>
					<span class="badge badge-amber">plans: {groupCount("planner-plan")}</span>
				</div>
			</div>
			<div class="flex shrink-0 gap-2">
				<button class="btn-secondary btn-sm" on:click={reindex}>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.51-7.13M21 4v5h-5"/></svg>
					Re-index
				</button>
				<button class="btn-danger btn-sm" on:click={deleteClient}>Delete</button>
			</div>
		</div>
	</header>

	<!-- Bound sources -->
	<section class="mt-l">
		<header class="mb-3 flex items-center justify-between">
			<div>
				<p class="section-eyebrow">Bindings</p>
				<h2 class="font-display text-h4 text-strong">Bound sources</h2>
			</div>
			<button class="btn-primary btn-sm" on:click={() => (showAdd ? (showAdd = false) : openAdd())}>
				{#if showAdd}
					Done
				{:else}
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
					Add sources
				{/if}
			</button>
		</header>

		{#if sources.length === 0}
			<div class="empty">
				<p class="font-display text-h5 text-strong">Nothing bound yet</p>
				<p class="mt-1 text-sm text-subtle">
					Click <strong>Add sources</strong> to pick channels, chats, SharePoint sites, or Planner plans
					that belong to this client.
				</p>
			</div>
		{:else}
			<ul class="surface overflow-hidden divide-y" style="border-color: var(--line-hairline);">
				{#each sources as s}
					<li class="flex items-center justify-between gap-3 px-4 py-3 hover:bg-recessed transition-colors duration-150">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class={typeBadge(s.sourceType)}>{s.sourceType}</span>
								<span class="truncate text-sm font-medium text-strong">{s.sourceName}</span>
							</div>
							{#if s.teamId}
								<div class="mt-1 text-xs text-subtle">team {s.teamId.slice(0, 8)}…</div>
							{/if}
						</div>
						<button class="btn-ghost btn-sm" on:click={() => remove(s.id)}>Detach</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if showAdd}
		<section class="mt-l surface-card space-y-l">
			<header>
				<p class="section-eyebrow">Picker</p>
				<h2 class="font-display text-h4 text-strong">Add bindings</h2>
				<p class="text-xs text-subtle">Click any item to attach it. Already-attached items are dimmed.</p>
			</header>

			<div>
				<h3 class="section-eyebrow mb-2">Teams channels</h3>
				<ul class="space-y-1">
					{#each teams as t}
						<li>
							<button type="button" class="flex w-full items-center justify-between rounded-s px-3 py-2 text-left text-sm hover:bg-recessed"
								on:click={() => toggleTeam(t)}>
								<span class="font-medium text-strong">{t.displayName}</span>
								<span class="text-xs text-subtle">{expandedTeams.has(t.id) ? "−" : "+"}</span>
							</button>
							{#if expandedTeams.has(t.id)}
								<ul class="ml-4 mt-1 space-y-0.5 border-l border-hairline pl-3">
									{#if !channelsByTeam[t.id]}
										<li class="text-xs text-subtle">Loading…</li>
									{:else}
										{#each channelsByTeam[t.id] as ch}
											<li>
												<button type="button" class="block w-full rounded-s px-2 py-1 text-left text-sm text-default hover:bg-recessed disabled:opacity-50"
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
				<h3 class="section-eyebrow mb-2">Chats</h3>
				<ul class="max-h-48 space-y-0.5 overflow-y-auto pr-1">
					{#each chats as c}
						<li>
							<button type="button" class="block w-full rounded-s px-2 py-1 text-left text-sm text-default hover:bg-recessed disabled:opacity-50"
								disabled={saving || isAttached("chat", c.id)}
								on:click={() => attachChat(c)}>
								{chatLabel(c)} <span class="text-xs text-subtle">({c.chatType})</span> {isAttached("chat", c.id) ? "(attached)" : ""}
							</button>
						</li>
					{/each}
				</ul>
			</div>

			<div>
				<h3 class="section-eyebrow mb-2">SharePoint sites</h3>
				<ul class="max-h-48 space-y-0.5 overflow-y-auto pr-1">
					{#each sites as s}
						<li>
							<button type="button" class="block w-full rounded-s px-2 py-1 text-left text-sm text-default hover:bg-recessed disabled:opacity-50"
								disabled={saving || isAttached("sharepoint-site", s.id)}
								on:click={() => attachSite(s)}>
								{s.displayName} {isAttached("sharepoint-site", s.id) ? "(attached)" : ""}
							</button>
						</li>
					{/each}
				</ul>
			</div>

			<div>
				<h3 class="section-eyebrow mb-2">Planner plans</h3>
				<ul class="max-h-48 space-y-0.5 overflow-y-auto pr-1">
					{#each plans as p}
						<li>
							<button type="button" class="block w-full rounded-s px-2 py-1 text-left text-sm text-default hover:bg-recessed disabled:opacity-50"
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
		<div class="banner banner-danger mt-4"><div><strong>Error.</strong> {error}</div></div>
	{/if}
{/if}
