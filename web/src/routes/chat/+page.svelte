<script lang="ts">
	import { postSse } from "$lib/sse";
	import type { ChatTurn } from "$lib/types";

	let input = "";
	let turns: ChatTurn[] = [];
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
			const stream = postSse("/api/webapp/chat/stream", { message: text });
			let buffer = "";
			for await (const { event, data } of stream) {
				if (event === "text" && typeof data === "object" && data !== null && "text" in data) {
					buffer += (data as { text: string }).text;
					turns = turns.map((t, i) => (i === assistantIndex ? { ...t, content: buffer } : t));
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

<section class="flex h-[calc(100vh-9rem)] flex-col">
	<header class="mb-4 flex items-end justify-between gap-4">
		<div>
			<p class="section-eyebrow">Conversation</p>
			<h1 class="font-display text-h2 text-strong">Ask Arcadia</h1>
			<p class="mt-1 max-w-prose-tight text-sm text-subtle">
				Grounded answers across your channels, chats, SharePoint sites, and Planner plans.
			</p>
		</div>
		<div class="hidden items-center gap-2 sm:flex">
			<span class="badge badge-blue">streaming</span>
			<span class="badge badge-neutral">M365</span>
		</div>
	</header>

	<div class="flex-1 space-y-3 overflow-y-auto pb-4">
		{#if turns.length === 0}
			<div class="empty mt-12">
				<div class="mx-auto flex max-w-prose-tight flex-col items-center gap-3">
					<span class="inline-flex h-10 w-10 items-center justify-center rounded-l text-white shadow-box-m"
						style="background: linear-gradient(135deg, #0C1830, #2C61E9);">
						<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
							stroke-linecap="round" stroke-linejoin="round">
							<path d="M4 4h16v12H7l-3 3z"/>
						</svg>
					</span>
					<p class="font-display text-h4 text-strong">Start a conversation</p>
					<p class="text-sm text-subtle">
						Try <span class="kbd">summarise this week's GNC threads</span>
						or <span class="kbd">what's pending for Acme Holdings?</span>
					</p>
				</div>
			</div>
		{/if}

		{#each turns as t, i (i)}
			<article
				class="rounded-l border px-4 py-3 shadow-box-m"
				class:bg-elevated={t.role === "assistant"}
				class:border-hairline={t.role === "assistant"}
				class:bg-recessed={t.role === "user"}
				class:border-strong={t.role === "user"}
			>
				<header class="mb-1.5 flex items-center gap-2">
					<span class="badge {t.role === 'user' ? 'badge-violet' : 'badge-blue'}">
						{t.role}
					</span>
					{#if t.pending}
						<span class="inline-flex items-center gap-1 text-subtle" aria-live="polite">
							<span class="loader-dot"></span>
							<span class="loader-dot"></span>
							<span class="loader-dot"></span>
						</span>
					{/if}
				</header>
				<div class="whitespace-pre-wrap text-sm leading-relaxed text-default">{t.content}</div>
			</article>
		{/each}
	</div>

	<form
		class="sticky bottom-0 -mx-4 border-t border-hairline bg-elevated px-4 py-3 md:-mx-8 md:px-8"
		on:submit|preventDefault={send}
	>
		<div class="flex items-end gap-2">
			<textarea
				class="textarea flex-1"
				rows="2"
				placeholder="Type a message…  (Shift+Enter for newline)"
				bind:value={input}
				on:keydown={onKey}
				disabled={busy}
			></textarea>
			<button class="btn-primary" type="submit" disabled={busy || input.trim().length === 0}>
				{#if busy}
					<span class="loader-dot"></span><span class="loader-dot"></span><span class="loader-dot"></span>
				{:else}
					Send
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M5 12h14M13 6l6 6-6 6"/>
					</svg>
				{/if}
			</button>
		</div>
		<p class="mt-2 text-[11px] text-subtle">
			Press <span class="kbd">Enter</span> to send · <span class="kbd">Shift</span>+<span class="kbd">Enter</span> for newline
		</p>
	</form>
</section>
