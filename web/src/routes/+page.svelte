<script lang="ts">
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	onMount(() => goto("/chat", { replaceState: true }));
</script>

<div class="flex items-center gap-2 text-sm text-subtle" role="status" aria-live="polite">
	<span class="loader-dot"></span>
	<span class="loader-dot"></span>
	<span class="loader-dot"></span>
	<span class="ml-1">Loading workspace…</span>
</div>
