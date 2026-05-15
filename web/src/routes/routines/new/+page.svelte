<script lang="ts">
	import { goto } from "$app/navigation";
	import { api } from "$lib/api";

	const EXAMPLE = JSON.stringify(
		{
			name: "Morning standup digest",
			description: "Stale-thread roll-up posted to the team chat at 9am.",
			trigger: { kind: "cron", cron: "0 9 * * 1-5" },
			steps: [
				{
					kind: "tool_call",
					tool: "list_stale_threads",
					input: { limit: 10 },
					as: "stale"
				},
				{
					kind: "ai_complete",
					system: "You are Arcadia. Summarise the stale threads in 3-5 bullets, named owners first.",
					prompt: "Stale threads:\n{{stale}}",
					tier: "balanced",
					as: "summary"
				},
				{
					kind: "post_text",
					serviceUrl: "https://smba.trafficmanager.net/amer/",
					conversationId: "<conversation-id>",
					text: "Morning:\n{{summary.text}}"
				}
			]
		},
		null,
		2,
	);

	let raw = EXAMPLE;
	let enabled = true;
	let saving = false;
	let error = "";

	async function save() {
		error = "";
		saving = true;
		try {
			let definition: unknown;
			try {
				definition = JSON.parse(raw);
			} catch (e) {
				throw new Error(`JSON parse: ${e instanceof Error ? e.message : String(e)}`);
			}
			await api.createRoutine(definition, enabled);
			await goto("/routines");
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function resetExample() {
		raw = EXAMPLE;
	}
</script>

<section class="space-y-6">
	<header class="flex items-start justify-between gap-4">
		<div>
			<p class="section-eyebrow">Automation</p>
			<h1 class="font-display text-h2 text-strong">New routine</h1>
			<p class="mt-1 max-w-prose-tight text-sm text-subtle">
				Paste a JSON definition. The server validates it against a Zod schema and rejects
				any invalid shape — error messages point at the exact path that failed.
			</p>
		</div>
		<a href="/routines" class="btn-secondary btn-sm">Cancel</a>
	</header>

	<form class="space-y-4" on:submit|preventDefault={save}>
		<label class="block">
			<span class="section-eyebrow">Definition (JSON)</span>
			<textarea
				class="textarea mt-1 font-mono text-xs"
				rows="24"
				bind:value={raw}
				spellcheck="false"
			></textarea>
		</label>

		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={enabled} />
			<span class="text-strong">Enable immediately</span>
		</label>

		{#if error}
			<div class="rounded-s border border-hairline bg-elevated p-3 text-sm text-strong">{error}</div>
		{/if}

		<div class="flex items-center gap-2">
			<button class="btn-primary" type="submit" disabled={saving}>
				{saving ? "Saving…" : "Create routine"}
			</button>
			<button class="btn-secondary" type="button" on:click={resetExample}>
				Reset example
			</button>
		</div>
	</form>

	<details class="rounded-s border border-hairline bg-elevated p-4 text-sm">
		<summary class="cursor-pointer font-semibold text-strong">Step kinds</summary>
		<div class="mt-3 space-y-2 text-subtle">
			<p><code class="kbd">recall_memory</code> — ACL-filtered vector recall. Stores hits under <code class="kbd">as</code>.</p>
			<p><code class="kbd">ai_complete</code> — single prompt through the tiered Router (fast/balanced/deep).</p>
			<p><code class="kbd">tool_call</code> — invokes an MCP tool by name with <code class="kbd">input</code>.</p>
			<p><code class="kbd">post_text</code> — proactive text message to a Bot Framework conversation.</p>
			<p><code class="kbd">create_task</code> — TaskStore.create() with optional owner/priority/deadline.</p>
			<p class="mt-2">Use <code class="kbd">&#123;&#123;name&#125;&#125;</code> or <code class="kbd">&#123;&#123;name.path&#125;&#125;</code> in any string to interpolate an earlier step's <code class="kbd">as</code> output.</p>
		</div>
	</details>
</section>
