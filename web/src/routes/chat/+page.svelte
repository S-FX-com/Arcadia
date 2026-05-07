<script lang="ts">
	import { postSse } from "$lib/sse";
	import type { ChatTurn, ToolCitation } from "$lib/types";

	let input = "";
	let turns: ChatTurn[] = [];
	let conversationId: string | undefined = undefined;
	let busy = false;

	async function send() {
		const text = input.trim();
		if (!text || busy) return;
		busy = true;
		input = "";

		turns = [...turns, { role: "user", content: text }];
		const assistantIndex = turns.length;
		turns = [...turns, { role: "assistant", content: "", pending: true }];

		try {
			const stream = postSse("/api/webapp/chat/stream", { message: text, conversationId });
			let buffer = "";
			let citations: ToolCitation[] = [];
			for await (const { event, data } of stream) {
				if (event === "text" && typeof data === "object" && data !== null && "chunk" in data) {
					buffer += (data as { chunk: string }).chunk;
					turns = turns.map((t, i) => (i === assistantIndex ? { ...t, content: buffer } : t));
				} else if (event === "citations" && Array.isArray(data)) {
					citations = data as ToolCitation[];
					turns = turns.map((t, i) => (i === assistantIndex ? { ...t, citations } : t));
				} else if (event === "done") {
					turns = turns.map((t, i) => (i === assistantIndex ? { ...t, pending: false } : t));
				} else if (event === "error" && typeof data === "object" && data !== null && "message" in data) {
					turns = turns.map((t, i) =>
						i === assistantIndex ? { ...t, content: `Error: ${(data as { message: string }).message}`, pending: false } : t,
					);
				}
			}
		} catch (err) {
			turns = turns.map((t, i) =>
				i === assistantIndex ? { ...t, content: `Error: ${err instanceof Error ? err.message : String(err)}`, pending: false } : t,
			);
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}
</script>

<section class="flex h-[calc(100vh-7rem)] flex-col">
	<div class="flex-1 space-y-4 overflow-y-auto pb-4">
		{#if turns.length === 0}
			<p class="mt-12 text-center text-sm text-zinc-500">
				Ask Arcadia anything about your tenant.
			</p>
		{/if}
		{#each turns as t, i (i)}
			<article
				class="prose prose-sm dark:prose-invert max-w-none rounded-lg border px-3 py-2"
				class:border-zinc-200={t.role === "assistant"}
				class:dark:border-zinc-800={t.role === "assistant"}
				class:border-zinc-300={t.role === "user"}
				class:bg-zinc-100={t.role === "user"}
				class:dark:border-zinc-700={t.role === "user"}
				class:dark:bg-zinc-900={t.role === "user"}
			>
				<header class="mb-1 text-xs uppercase tracking-wide text-zinc-500">
					{t.role}
					{#if t.pending}<span class="ml-2 animate-pulse">…</span>{/if}
				</header>
				<div class="whitespace-pre-wrap">{t.content}</div>
				{#if t.citations && t.citations.length > 0}
					<footer class="mt-2 flex flex-wrap gap-1.5">
						{#each t.citations as c}
							<span class="chip" title={`${c.resourceType}:${c.resourceId}`}>
								{c.label ?? `${c.resourceType}`}
							</span>
						{/each}
					</footer>
				{/if}
			</article>
		{/each}
	</div>

	<form
		class="sticky bottom-0 -mx-4 border-t border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
		on:submit|preventDefault={send}
	>
		<div class="flex items-end gap-2">
			<textarea
				class="flex-1 resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				rows="2"
				placeholder="Type a message…"
				bind:value={input}
				on:keydown={onKey}
				disabled={busy}
			></textarea>
			<button class="btn" type="submit" disabled={busy || input.trim().length === 0}>Send</button>
		</div>
	</form>
</section>
