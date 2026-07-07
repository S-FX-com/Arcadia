import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["test/integration/**", "node_modules/**", "dist/**"],
		environment: "node",
		globals: false,
	},
});
