import {m2BuildInfo} from './build-info.mjs';
import {writeFile} from 'node:fs/promises';
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
const info=m2BuildInfo({moduleRoot:fileURLToPath(new URL('./',import.meta.url))});
await build({define:{__M2_BUILD_INFO__:JSON.stringify(info)},root:fileURLToPath(new URL('./',import.meta.url)),configFile:false,base:'/m2/',build:{outDir:'dist',rollupOptions:{input:new URL('app.jsx',import.meta.url).pathname,output:{entryFileNames:'app.js',assetFileNames:a=>a.names?.some(n=>n.endsWith('.css'))?'app.css':'[name][extname]'}}}});

await writeFile(new URL('./dist/build-info.json',import.meta.url),JSON.stringify(info,null,2)+'\n');
