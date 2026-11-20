import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  // Gloam's SDK imports circomlibjs for Poseidon; Cloak's SDK ships a stand-in with identical outputs, far smaller.
  resolve: { alias: { circomlibjs: "@cloakely/sdk/circomlibjs-lite" } },
  build: { chunkSizeWarningLimit: 2000 },
});
