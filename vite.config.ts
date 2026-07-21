import "vite-plus/test/config";

import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

const setupFile = resolve(import.meta.dirname, "scripts/vp3-vitest-setup.ts");

/**
 * Canonical @openagentsinc/ai Vite Plus configuration — the same toolchain
 * contract as the openagents monorepo this SDK was extracted from.
 */
export default defineConfig({
  root: import.meta.dirname,
  pack: {
    dts: { eager: true },
    deps: {
      alwaysBundle: [/^@openagentsinc\//],
      onlyBundle: false,
      dts: { alwaysBundle: [/^@openagentsinc\//] },
    },
  },
  staged: {
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: ["dist/**", "node_modules/**", "pnpm-lock.yaml", "**/*.tsbuildinfo"],
  },
  test: {
    projects: [
      {
        test: {
          name: { label: "node", color: "green" },
          include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
          setupFiles: [setupFile],
        },
      },
    ],
  },
});
