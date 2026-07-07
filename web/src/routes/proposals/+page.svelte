<script lang="ts">
	import { onMount } from "svelte";
	import { api } from "$lib/api";
	import type { Proposal } from "$lib/types";

	let proposals: Proposal[] = [];
	let loading = true;
	let error = "";
	let forbidden = false;
	let busy: Record<string, boolean> = {};

	async function load() {
		loading = true;
		error = "";
		forbidden = false;
		try {
			const res = await api.proposals("pending");
			proposals = res.proposals;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("403")) forbidden = true;
			else error = msg;
		} finally {
			loading = false;
		}
	}

	async function decide(id: string, action: "approve" | "reject") {
		if (
			action === "approve" &&
			!confirm("Approve and apply this proposal? This changes Arcadia's behaviour.")
		)
			return;
		busy = { ...busy, [id]: true };
		try {
			if (action === "approve") await api.approveProposal(id);
			else await api.rejectProposal(id);
			proposals = proposals.filter((p) => p.id !== id);
		} catch (e) {
			alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			busy = { ...busy, [id]: false };
		}
	}

	function kindBadge(kind: string): string {
		switch (kind) {
			case "charter_amendment": return "badge badge-blue";
			case "memory_correction": return "badge badge-violet";
			case "procedure":         return "badge badge-cyan";
			case "routine":           return "badge badge-amber";
			default:                  return "badge badge-neutral";
		}
	}

	function kindLabel(kind: string): string {
		return kind.replace(/_/g, " ");
	}

	function detail(p: Proposal): string | null {
		const payload = p.payload as Record<string, unknown> | null;
		if (!payload || typeof payload !== "object") return null;
		const clause = payload.suggestedClause ?? payload.suggestedCorrection ?? payload.body;
		return typeof clause === "string" ? clause : null;
	}

	function fmtIso(iso: string | null | undefined): string {
		if (!iso) return "—";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	onMount(load);
</script>

<header class="flex items-start justify-between gap-4">
	<div>
		<p class="section-eyebrow">Learning</p>
		<h1 class="font-display text-h2 text-strong">Proposals</h1>
		<p class="mt-2 max-w-prose-tight text-sm text-subtle">
			Arcadia's review queue. Eval failures and feedback signals become <strong>proposed</strong>
			remedies — a charter clause, a memory correction, a promotion. Nothing takes effect until
			you approve it.
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
		<span class="ml-1">Loading proposals…</span>
	</div>
{:else if forbidden}
	<div class="empty mt-6">
		<p class="font-display text-h4 text-strong">Admin only</p>
		<p class="mt-1 text-sm text-subtle">The review queue is available to operators (admins) only.</p>
	</div>
{:else if error}
	<div class="banner banner-danger mt-6"><div><strong>Error.</strong> {error}</div></div>
{:else if proposals.length === 0}
	<div class="empty mt-6">
		<p class="font-display text-h4 text-strong">Nothing to review</p>
		<p class="mt-1 text-sm text-subtle">
			No pending proposals. Eval failures on the nightly run land here for your approval.
		</p>
	</div>
{:else}
	<section class="mt-6">
		<div class="surface overflow-hidden">
			<ul class="divide-y" style="border-color: var(--line-hairline);">
				{#each proposals as p (p.id)}
					<li class="flex items-start justify-between gap-4 px-4 py-3">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class={kindBadge(p.kind)}>{kindLabel(p.kind)}</span>
								<span class="badge badge-neutral">{p.origin}</span>
								<h3 class="truncate font-medium text-strong">{p.title}</h3>
							</div>
							{#if p.rationale}
								<p class="mt-1.5 text-sm text-subtle">{p.rationale}</p>
							{/if}
							{#if detail(p)}
								<blockquote class="mt-2 border-l-2 pl-3 text-sm text-strong" style="border-color: var(--line-hairline);">
									{detail(p)}
								</blockquote>
							{/if}
							<p class="mt-1.5 text-xs text-subtle">proposed {fmtIso(p.createdAt)}</p>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<button class="btn-primary btn-sm" disabled={busy[p.id]} on:click={() => decide(p.id, "approve")}>Approve</button>
							<button class="btn-ghost btn-sm" disabled={busy[p.id]} on:click={() => decide(p.id, "reject")}>Reject</button>
						</div>
					</li>
				{/each}
			</ul>
		</div>
	</section>
{/if}
