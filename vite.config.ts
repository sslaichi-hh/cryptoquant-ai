import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) return 'react-vendor';
            if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) return 'chart-vendor';
            if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons-vendor';
            return undefined;
          },
        },
      },
    },
  };
});
