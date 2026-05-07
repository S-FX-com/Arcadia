<script lang="ts">
	import "../app.css";
</script>

<header class="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
	<nav class="mx-auto flex max-w-3xl items-center justify-between">
		<a href="/" class="text-base font-semibold tracking-tight">Arcadia</a>
		<div class="flex items-center gap-4 text-sm text-zinc-500">
			<a href="/chat" class="hover:text-zinc-900 dark:hover:text-zinc-100">Chat</a>
			<a href="/routines" class="hover:text-zinc-900 dark:hover:text-zinc-100">Routines</a>
			<a href="/sources" class="hover:text-zinc-900 dark:hover:text-zinc-100">Sources</a>
		</div>
	</nav>
</header>

<main class="mx-auto max-w-3xl px-4 py-6">
	<slot />
</main>
