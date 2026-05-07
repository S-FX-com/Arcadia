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
	let color = "#00b4d8";
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
		// Pre-fill from ?name=
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
			// 1) Create the client row.
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

			// 2) Attach every selected source. Run in parallel; collect failures.
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
	<h1 class="text-xl font-semibold">New Client</h1>
	<p class="mt-1 text-sm text-zinc-500">
		Define an umbrella over the M365 surfaces that belong to this engagement.
		Arcadia will keep rolling memory of activity inside the umbrella and ground
		client-mode answers in these channels, chats, sites, and plans.
	</p>
</header>

<form class="mt-6 space-y-6" on:submit|preventDefault={save}>
	<section class="space-y-3">
		<label class="block">
			<span class="text-sm font-medium">Name</span>
			<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				required maxlength="120" bind:value={name} placeholder="Acme Holdings" />
		</label>
		<label class="block">
			<span class="text-sm font-medium">Description (optional)</span>
			<input class="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				maxlength="500" bind:value={description} placeholder="Managed services + web — Engagement since 2024" />
		</label>
		<label class="flex items-center gap-2 text-sm">
			<span class="font-medium">Color</span>
			<input type="color" bind:value={color} class="h-7 w-10 cursor-pointer rounded border border-zinc-300 dark:border-zinc-700" />
		</label>
	</section>

	<section class="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
		<header class="flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Teams channels</h2>
			<span class="text-xs text-zinc-500">{selectedChannels.size} selected</span>
		</header>
		{#if loadingTeams}
			<p class="text-sm text-zinc-500">Loading teams…</p>
		{:else if teams.length === 0}
			<p class="text-sm text-zinc-500">No teams accessible to your account.</p>
		{:else}
			<ul class="space-y-1">
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
									<li class="text-xs text-zinc-500">Loading channels…</li>
								{:else if channelsByTeam[t.id].length === 0}
									<li class="text-xs text-zinc-500">No channels.</li>
								{:else}
									{#each channelsByTeam[t.id] as ch}
										<li>
											<label class="flex items-center gap-2 rounded px-2 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
												<input type="checkbox" checked={selectedChannels.has(ch.id)}
													on:change={() => toggleChannel(t, ch)} />
												<span>#{ch.displayName}</span>
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

	<section class="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
		<header class="flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Chats</h2>
			<span class="text-xs text-zinc-500">{selectedChats.size} selected</span>
		</header>
		{#if loadingChats}
			<p class="text-sm text-zinc-500">Loading chats…</p>
		{:else if chats.length === 0}
			<p class="text-sm text-zinc-500">No chats found.</p>
		{:else}
			<ul class="max-h-64 space-y-1 overflow-y-auto">
				{#each chats as c}
					<li>
						<label class="flex items-center gap-2 rounded px-2 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
							<input type="checkbox" checked={selectedChats.has(c.id)} on:change={() => toggleChat(c)} />
							<span>{chatLabel(c)} <span class="text-xs text-zinc-500">({c.chatType})</span></span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
		<header class="flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">SharePoint sites</h2>
			<span class="text-xs text-zinc-500">{selectedSites.size} selected</span>
		</header>
		{#if loadingSites}
			<p class="text-sm text-zinc-500">Loading sites…</p>
		{:else if sites.length === 0}
			<p class="text-sm text-zinc-500">No SharePoint sites found.</p>
		{:else}
			<ul class="max-h-64 space-y-1 overflow-y-auto">
				{#each sites as s}
					<li>
						<label class="flex items-center gap-2 rounded px-2 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
							<input type="checkbox" checked={selectedSites.has(s.id)} on:change={() => toggleSite(s)} />
							<span>{s.displayName}</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
		<header class="flex items-center justify-between">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-500">Planner plans</h2>
			<span class="text-xs text-zinc-500">{selectedPlans.size} selected</span>
		</header>
		{#if loadingPlans}
			<p class="text-sm text-zinc-500">Loading plans…</p>
		{:else if plans.length === 0}
			<p class="text-sm text-zinc-500">No Planner plans found.</p>
		{:else}
			<ul class="max-h-64 space-y-1 overflow-y-auto">
				{#each plans as p}
					<li>
						<label class="flex items-center gap-2 rounded px-2 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
							<input type="checkbox" checked={selectedPlans.has(p.id)} on:change={() => togglePlan(p)} />
							<span>{p.title}</span>
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if error}
		<p class="text-sm text-red-500">{error}</p>
	{/if}

	<footer class="flex items-center justify-between gap-2">
		<span class="text-xs text-zinc-500">{selectedTotal} sources selected. You can add or remove sources later.</span>
		<div class="flex gap-2">
			<a class="btn" href="/clients">Cancel</a>
			<button class="btn" type="submit" disabled={saving || !name.trim()}>
				{saving ? "Saving…" : "Create Client"}
			</button>
		</div>
	</footer>
</form>
