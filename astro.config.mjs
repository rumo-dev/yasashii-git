import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://rumo-dev.github.io',
  base: process.env.BASE_PATH || '/yasashii-git',
  outDir: './dist-site',
  build: {
    assets: '_astro',
  },
});
