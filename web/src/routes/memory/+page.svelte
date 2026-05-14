<script lang="ts">
	import { api } from "$lib/api";
	import type { MemoryHit } from "$lib/types";

	let query = "";
	let scopeType: "" | "channel" | "chat" | "user" | "project" | "customer" | "tenant" = "";
	let scopeId = "";
	let kind: "" | "episodic" | "semantic" | "procedural" | "observation" = "";
	let hits: MemoryHit[] = [];
	let busy = false;
	let error: string | null = null;
	let forgetting = new Set<string>();

	async function search() {
		if (!query.trim()) return;
		busy = true;
		error = null;
		try {
			const opts: Record<string, string | number> = { limit: 20 };
			if (scopeType) opts.scopeType = scopeType;
			if (scopeId) opts.scopeId = scopeId;
			if (kind) opts.kind = kind;
			const res = await api.recall(query, opts);
			hits = res.hits;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			hits = [];
		} finally {
			busy = false;
		}
	}

	async function forget(id: string) {
		forgetting = new Set([...forgetting, id]);
		try {
			await api.forgetMemory(id);
			hits = hits.filter((h) => h.memory.id !== id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			const next = new Set(forgetting);
			next.delete(id);
			forgetting = next;
		}
	}
</script>

<section class="space-y-6">
	<header>
		<p class="section-eyebrow">Recall</p>
		<h1 class="font-display text-h2 text-strong">Memory</h1>
		<p class="mt-1 text-sm text-subtle">
			Search Arcadia's memory across the four cognitive layers. Strict ACL — you'll only see memories you're authorised to see.
		</p>
	</header>

	<form class="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_180px_140px_auto]"
	      on:submit|preventDefault={search}>
		<input
			class="input"
			placeholder="Ask the memory…"
			bind:value={query}
			required
		/>
		<select class="input" bind:value={scopeType}>
			<option value="">Any scope</option>
			<option value="channel">channel</option>
			<option value="chat">chat</option>
			<option value="user">user</option>
			<option value="project">project</option>
			<option value="customer">customer</option>
			<option value="tenant">tenant</option>
		</select>
		<input
			class="input"
			placeholder="scope id (optional)"
			bind:value={scopeId}
		/>
		<select class="input" bind:value={kind}>
			<option value="">Any kind</option>
			<option value="episodic">episodic</option>
			<option value="semantic">semantic</option>
			<option value="procedural">procedural</option>
			<option value="observation">observation</option>
		</select>
		<button class="btn-primary" type="submit" disabled={busy}>
			{busy ? "Searching…" : "Recall"}
		</button>
	</form>

	{#if error}
		<div class="rounded-s border border-hairline bg-elevated p-3 text-sm text-strong">
			{error}
		</div>
	{/if}

	{#if hits.length > 0}
		<ul class="space-y-3">
			{#each hits as h (h.memory.id)}
				<li class="rounded-s border border-hairline bg-elevated p-4">
					<div class="flex items-start justify-between gap-3">
						<div class="space-y-1">
							<p class="text-xs text-subtle">
								{h.memory.kind} · {h.memory.scopeType}:{h.memory.scopeId} ·
								score {h.score.toFixed(2)}
							</p>
							<p class="text-sm text-strong whitespace-pre-wrap">{h.memory.content}</p>
							<p class="text-xs text-subtle">{h.memory.occurredAt ?? h.memory.createdAt}</p>
						</div>
						<button
							class="btn-secondary btn-sm"
							on:click={() => forget(h.memory.id)}
							disabled={forgetting.has(h.memory.id)}
						>
							Forget
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{:else if !busy && query}
		<p class="text-sm text-subtle">No matches.</p>
	{/if}
</section>
