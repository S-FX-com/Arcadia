<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import { page } from "$app/stores";
	import { configureMgt } from "$lib/mgt";

	onMount(() => {
		void configureMgt();
	});

	$: path = $page.url.pathname;
	function active(prefix: string) {
		return path === prefix || path.startsWith(prefix + "/");
	}

	const nav = [
		{ href: "/dashboard", label: "Dashboard", icon: "M3 12h7V3H3zM14 21h7v-9h-7zM3 21h7v-6H3zM14 10h7V3h-7z" },
		{ href: "/chat",      label: "Chat",      icon: "M4 4h16v12H7l-3 3z" },
		{ href: "/routines",  label: "Routines",  icon: "M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
		{ href: "/memory",    label: "Memory",    icon: "M12 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 22v-6M8 22h8" },
		{ href: "/sources",   label: "Sources",   icon: "M4 7l8-4 8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4" },
		{ href: "/proposals", label: "Proposals", icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
		{ href: "/actions",   label: "Actions",   icon: "M13 2L3 14h7l-1 8 10-12h-7z" },
		{ href: "/settings",  label: "Settings",  icon: "M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
	];
</script>

<div class="grid min-h-screen grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
	<!-- Sidebar -->
	<aside class="hidden border-r border-hairline bg-elevated md:flex md:flex-col">
		<div class="flex h-14 items-center gap-2 px-4 border-b border-hairline">
			<span class="inline-flex h-7 w-7 items-center justify-center rounded-s text-white font-display text-sm" style="background: linear-gradient(135deg, #0C1830, #2C61E9);">A</span>
			<span class="font-display text-lg font-semibold tracking-tight text-strong">Arcadia</span>
		</div>

		<nav class="flex-1 space-y-1 px-2 py-4">
			<p class="px-3 pb-2 section-eyebrow">Workspace</p>
			{#each nav as item}
				<a
					href={item.href}
					class="sidebar-link"
					aria-current={active(item.href) ? "page" : undefined}
				>
					<svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
						<path d={item.icon} />
					</svg>
					<span>{item.label}</span>
				</a>
			{/each}
		</nav>

		<div class="border-t border-hairline px-4 py-3 text-xs text-subtle">
			<div class="flex items-center gap-2">
				<span class="inline-block h-1.5 w-1.5 rounded-full" style="background: #29A745"></span>
				<span>Connected · M365</span>
			</div>
		</div>
	</aside>

	<!-- Main column -->
	<div class="flex min-w-0 flex-col">
		<!-- Top bar (mobile + breadcrumb) -->
		<header class="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-hairline bg-elevated/90 px-4 backdrop-blur md:px-6">
			<div class="flex items-center gap-2 md:hidden">
				<span class="inline-flex h-7 w-7 items-center justify-center rounded-s text-white font-display text-sm" style="background: linear-gradient(135deg, #0C1830, #2C61E9);">A</span>
				<span class="font-display text-base font-semibold text-strong">Arcadia</span>
			</div>
			<nav aria-label="Breadcrumb" class="hidden items-center gap-2 text-sm text-subtle md:flex">
				<a href="/" class="hover:text-strong">Home</a>
				<span aria-hidden="true">/</span>
				<span class="text-strong">{path.split("/")[1] || "chat"}</span>
			</nav>
			<div class="flex items-center gap-2">
				<a href="/routines/new" class="btn-secondary btn-sm">New routine</a>
				<a href="/chat" class="btn-primary btn-sm">Ask Arcadia</a>
			</div>
		</header>

		<!-- Mobile nav strip -->
		<nav class="flex gap-1 overflow-x-auto border-b border-hairline bg-elevated px-3 py-2 md:hidden">
			{#each nav as item}
				<a href={item.href} class="rounded-s px-3 py-1.5 text-sm whitespace-nowrap"
				   aria-current={active(item.href) ? "page" : undefined}
				   class:bg-recessed={active(item.href)}
				   class:font-semibold={active(item.href)}
				   class:text-strong={active(item.href)}
				   class:text-subtle={!active(item.href)}>
					{item.label}
				</a>
			{/each}
		</nav>

		<main class="mx-auto w-full max-w-content flex-1 px-4 py-6 md:px-8 md:py-8">
			<slot />
		</main>

		<footer class="border-t border-hairline px-4 py-4 text-xs text-subtle md:px-8">
			<div class="mx-auto flex max-w-content items-center justify-between">
				<span>Arcadia · S-FX</span>
				<span>UI redesigned with Kumo elements</span>
			</div>
		</footer>
	</div>
</div>
