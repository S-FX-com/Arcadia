<script lang="ts">
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	onMount(() => goto("/chat", { replaceState: true }));
</script>

<p class="text-sm text-zinc-500">Loading…</p>
