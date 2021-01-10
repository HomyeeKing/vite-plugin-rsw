# vite-plugin-rsw

> wasm-pack plugin for vite@v2

## Getting Started

> Install rsw

```bash
npm i -D vite-plugin-rsw
```

> vite.config.ts

```js
import { defineConfig } from 'vite'
import { ViteRsw } from 'vite-plugin-rsw';

export default defineConfig({
  plugins: [
    ViteRsw({
      // target: 'web',
      mode: 'release',
      crates: [
        {
          path: './rust-crate',
          // outName: '',
          // scope: '',
        },
      ],
    }),
  ],
})
```
