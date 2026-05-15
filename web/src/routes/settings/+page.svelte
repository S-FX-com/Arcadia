<script lang="ts">
	import { onMount } from "svelte";
	import { api } from "$lib/api";
	import type { Session } from "$lib/types";

	let session: Session | null = null;
	let error: string | null = null;
	let busy = false;

	onMount(async () => {
		try {
			const res = await api.me();
			session = res.session;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	async function logout() {
		busy = true;
		try {
			await api.logout();
			session = null;
			window.location.href = "/";
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-6">
	<header>
		<p class="section-eyebrow">Account</p>
		<h1 class="font-display text-h2 text-strong">Settings</h1>
	</header>

	{#if error}
		<div class="rounded-s border border-hairline bg-elevated p-3 text-sm text-strong">{error}</div>
	{/if}

	{#if session}
		<div class="rounded-s border border-hairline bg-elevated p-4 text-sm">
			<dl class="grid grid-cols-[120px_1fr] gap-y-2">
				<dt class="text-subtle">Name</dt><dd class="text-strong">{session.name ?? "—"}</dd>
				<dt class="text-subtle">UPN</dt><dd class="text-strong">{session.upn ?? "—"}</dd>
				<dt class="text-subtle">AAD object id</dt><dd class="text-strong font-mono text-xs">{session.aadId}</dd>
				<dt class="text-subtle">Tenant id</dt><dd class="text-strong font-mono text-xs">{session.tenantId}</dd>
				<dt class="text-subtle">Session expires</dt><dd class="text-strong">{new Date(session.exp * 1000).toLocaleString()}</dd>
			</dl>
		</div>

		<div>
			<button class="btn-secondary" on:click={logout} disabled={busy}>
				{busy ? "Signing out…" : "Sign out"}
			</button>
		</div>
	{:else if !error}
		<p class="text-sm text-subtle">Loading session…</p>
	{/if}
</section>
