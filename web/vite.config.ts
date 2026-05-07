import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		// During dev, proxy /api/* to the local wrangler worker so the chat
		// surface can hit the streaming endpoint without CORS gymnastics.
		proxy: {
			"/api": {
				target: "http://127.0.0.1:8787",
				changeOrigin: true,
			},
		},
	},
});
