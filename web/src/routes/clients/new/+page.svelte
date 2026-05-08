<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import {
		loadTeams, loadChannels, loadChats, loadSharePoint, loadPlannerPlans,
		chatLabel, attachSource,
		type UserTeam, type UserChannel, type UserChat, type SharePointSite, type PlannerPlan,
		type PickerSource,
	} from "$lib/client-source-picker";

	let name = "";
	let description = "";
	let color = "#00B7F9";
	let saving = false;
	let error = "";

	let teams: UserTeam[] = [];
	let channelsByTeam: Record<string, UserChannel[]> = {};
	let expandedTeams = new Set<string>();
	let chats: UserChat[] = [];
	let sites: SharePointSite[] = [];
	let plans: PlannerPlan[] = [];

	let selectedChannels = new Map<string, { teamId: string; teamName: string; channelName: string }>();
	let selectedChats = new Map<string, string>();
	let selectedSites = new Map<string, string>();
	let selectedPlans = new Map<string, string>();

	let loadingTeams = true;
	let loadingChats = true;
	let loadingSites = true;
	let loadingPlans = true;

	$: selectedTotal =
		selectedChannels.size + selectedChats.size + selectedSites.size + selectedPlans.size;

	onMount(async () => {
		const q = $page.url.searchParams.get("name");
		if (q) name = q;

		void loadTeams().then((t) => { teams = t; }).catch((e) => { error = `Teams: ${e.message}`; }).finally(() => { loadingTeams = false; });
		void loadChats().then((c) => { chats = c; }).catch((e) => { error = `Chats: ${e.message}`; }).finally(() => { loadingChats = false; });
		void loadSharePoint().then((s) => { sites = s; }).catch((e) => { error = `SharePoint: ${e.message}`; }).finally(() => { loadingSites = false; });
		void loadPlannerPlans().then((p) => { plans = p; }).catch((e) => { error = `Planner: ${e.message}`; }).finally(() => { loadingPlans = false; });
	});

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
				error = `Channels for ${t.displayName}: ${e instanceof Error ? e.message : String(e)}`;
			}
		}
	}

	function toggleChannel(t: UserTeam, ch: UserChannel) {
		if (selectedChannels.has(ch.id)) selectedChannels.delete(ch.id);
		else selectedChannels.set(ch.id, { teamId: t.id, teamName: t.displayName, channelName: ch.displayName });
		selectedChannels = selectedChannels;
	}

	function toggleChat(c: UserChat) {
		if (selectedChats.has(c.id)) selectedChats.delete(c.id);
		else selectedChats.set(c.id, chatLabel(c));
		selectedChats = selectedChats;
	}
	function toggleSite(s: SharePointSite) {
		if (selectedSites.has(s.id)) selectedSites.delete(s.id);
		else selectedSites.set(s.id, s.displayName);
		selectedSites = selectedSites;
	}
	function togglePlan(p: PlannerPlan) {
		if (selectedPlans.has(p.id)) selectedPlans.delete(p.id);
		else selectedPlans.set(p.id, p.title);
		selectedPlans = selectedPlans;
	}

	async function save() {
		error = "";
		if (!name.trim()) { error = "Name is required"; return; }
		saving = true;
		try {
			const createRes = await fetch("/api/webapp/clients", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "include",
				body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, color }),
			});
			if (!createRes.ok) {
				const text = await createRes.text();
				throw new Error(`Create failed (${createRes.status}): ${text}`);
			}
			const { client } = await createRes.json() as { client: { id: string } };

			const bindings: PickerSource[] = [];
			for (const [chId, info] of selectedChannels) {
				bindings.push({
					sourceType: "channel",
					sourceId: chId,
					sourceName: `${info.teamName} › ${info.channelName}`,
					teamId: info.teamId,
					metadata: { teamName: info.teamName, channelName: info.channelName },
				});
			}
			for (const [id, label] of selectedChats) bindings.push({ sourceType: "chat", sourceId: id, sourceName: label });
			for (const [id, label] of selectedSites) bindings.push({ sourceType: "sharepoint-site", sourceId: id, sourceName: label });
			for (const [id, label] of selectedPlans) bindings.push({ sourceType: "planner-plan", sourceId: id, sourceName: label });

			const results = await Promise.allSettled(bindings.map((b) => attachSource(client.id, b)));
			const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
			if (failures.length > 0) {
				console.error("Some source bindings failed:", failures.map((f) => f.reason));
				error = `${bindings.length - failures.length}/${bindings.length} sources attached. ${failures.length} failed — see console.`;
				saving = false;
				return;
			}

			await goto(`/clients/${client.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			saving = false;
		}
	}
</script>

<header>
	<p class="section-eyebrow">Workspace · Setup</p>
	<h1 class="font-display text-h2 text-strong">New client</h1>
	<p class="mt-2 max-w-prose-tight text-sm text-subtle">
		Define an umbrella over the M365 surfaces that belong to this engagement.
		Arcadia keeps rolling memory of activity inside the umbrella and grounds
		client-mode answers in these channels, chats, sites, and plans.
	</p>
</header>

<form class="mt-l space-y-l" on:submit|preventDefault={save}>
	<!-- Identity -->
	<section class="surface-card">
		<header class="mb-3">
			<h2 class="font-display text-h5 text-strong">Identity</h2>
			<p class="text-xs text-subtle">Visible name, description, and palette swatch for this client.</p>
		</header>
		<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
			<label class="field">
				<span class="field-label">Name</span>
				<input class="input" required maxlength="120" bind:value={name} placeholder="Acme Holdings" />
			</label>
			<label class="field">
				<span class="field-label">Color</span>
				<div class="flex items-center gap-3">
					<input type="color" bind:value={color} class="h-9 w-16 cursor-pointer rounded-s border border-strong bg-elevated" />
					<span class="kbd">{color}</span>
				</div>
			</label>
			<label class="field md:col-span-2">
				<span class="field-label">Description (optional)</span>
				<input class="input" maxlength="500" bind:value={description}
					placeholder="Managed services + web — Engagement since 2024" />
			</label>
		</div>
	</section>

	<!-- Teams channels -->
	<section class="surface-card">
		<header class="mb-3 flex items-center justify-between">
			<div>
				<h2 class="font-display text-h5 text-strong">Teams channels</h2>
				<p class="text-xs text-subtle">Expand a team to pick channels.</p>
			</div>
			<span class="badge badge-blue">{selectedChannels.size} selected</span>
		</header>
		{#if loadingTeams}
			<p class="text-sm text-subtle">Loading teams…</p>
		{:else if teams.length === 0}
			<p class="text-sm text-subtle">No teams accessible to your account.</p>
		{:else}
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
									<li class="text-xs text-subtle">Loading channels…</li>
								{:else if channelsByTeam[t.id].length === 0}
									<li class="text-xs text-subtle">No channels.</li>
								{:else}
									{#each channelsByTeam[t.id] as ch}
										<li>
											<label class="flex items-center gap-2 rounded-s px-2 py-1 text-sm hover:bg-recessed cursor-pointer">
												<input type="checkbox" checked={selectedChannels.has(ch.id)}
													on:change={() => toggleChannel(t, ch)} />
												<span class="text-default">#{ch.displayName}</span>
											</label>
										</li>
									{/each}
								{/if}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Chats -->
	<section class="surface-card">
		<header class="mb-3 flex items-center justify-between">
			<div>
				<h2 class="font-display text-h5 text-strong">Chats</h2>
				<p class="text-xs text-subtle">1:1 and group chats.</p>
			</div>
			<span class="badge badge-violet">{selectedChats.size} selected</span>
		</header>
		{#if loadingChats}
			<p class="text-sm text-subtle">Loading chats…</p>
		{:else if chats.length === 0}
			<p class="text-sm text-subtle">No chats found.</p>
		{:else}
			<ul class="max-h-64 space-y-0.5 overflow-y-auto pr-1">
				{#each chats as c}
					<li>
						<label class="flex items-center gap-2 rounded-s px-2 py-1 text-sm hover:bg-recessed cursor-pointer">
							<input type="checkbox" checked={selectedChats.has(c.id)} on:change={() => toggleChat(c)} />
							<span class="text-default">{chatLabel(c)}</span>
							<span class="badge badge-neutral">{c.chatType}</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- SharePoint -->
	<section class="surface-card">
		<header class="mb-3 flex items-center justify-between">
			<div>
				<h2 class="font-display text-h5 text-strong">SharePoint sites</h2>
				<p class="text-xs text-subtle">Document libraries and pages.</p>
			</div>
			<span class="badge badge-cyan">{selectedSites.size} selected</span>
		</header>
		{#if loadingSites}
			<p class="text-sm text-subtle">Loading sites…</p>
		{:else if sites.length === 0}
			<p class="text-sm text-subtle">No SharePoint sites found.</p>
		{:else}
			<ul class="max-h-64 space-y-0.5 overflow-y-auto pr-1">
				{#each sites as s}
					<li>
						<label class="flex items-center gap-2 rounded-s px-2 py-1 text-sm hover:bg-recessed cursor-pointer">
							<input type="checkbox" checked={selectedSites.has(s.id)} on:change={() => toggleSite(s)} />
							<span class="text-default">{s.displayName}</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Planner -->
	<section class="surface-card">
		<header class="mb-3 flex items-center justify-between">
			<div>
				<h2 class="font-display text-h5 text-strong">Planner plans</h2>
				<p class="text-xs text-subtle">Tasks & buckets.</p>
			</div>
			<span class="badge badge-amber">{selectedPlans.size} selected</span>
		</header>
		{#if loadingPlans}
			<p class="text-sm text-subtle">Loading plans…</p>
		{:else if plans.length === 0}
			<p class="text-sm text-subtle">No Planner plans found.</p>
		{:else}
			<ul class="max-h-64 space-y-0.5 overflow-y-auto pr-1">
				{#each plans as p}
					<li>
						<label class="flex items-center gap-2 rounded-s px-2 py-1 text-sm hover:bg-recessed cursor-pointer">
							<input type="checkbox" checked={selectedPlans.has(p.id)} on:change={() => togglePlan(p)} />
							<span class="text-default">{p.title}</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if error}
		<div class="banner banner-danger"><div><strong>Error.</strong> {error}</div></div>
	{/if}

	<footer class="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-hairline bg-elevated px-4 py-3 md:-mx-8 md:px-8">
		<span class="text-xs text-subtle">
			<strong class="text-strong">{selectedTotal}</strong> source{selectedTotal === 1 ? "" : "s"} selected.
			You can add or remove sources later.
		</span>
		<div class="flex gap-2">
			<a class="btn-secondary" href="/clients">Cancel</a>
			<button class="btn-primary" type="submit" disabled={saving || !name.trim()}>
				{#if saving}
					<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
					Saving
				{:else}
					Create client
				{/if}
			</button>
		</div>
	</footer>
</form>
