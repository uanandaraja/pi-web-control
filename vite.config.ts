import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const bridgePort = process.env.PI_WEB_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${bridgePort}`,
      "/ws": {
        target: `ws://127.0.0.1:${bridgePort}`,
        ws: true,
      },
    },
  },
});
