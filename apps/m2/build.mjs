import {build} from 'vite';
import {fileURLToPath} from 'node:url';
await build({root:fileURLToPath(new URL('./',import.meta.url)),configFile:false,base:'/m2/',build:{outDir:'dist',rollupOptions:{input:new URL('app.jsx',import.meta.url).pathname,output:{entryFileNames:'app.js',assetFileNames:a=>a.names?.some(n=>n.endsWith('.css'))?'app.css':'[name][extname]'}}}});
