// 桌面版的产物（electron-builder 打包前跑），都放在 app/（打包时的项目目录，--projectDir app）：
// - app/package.json：装进去的包名 tianshu-desktop（一键安装按它定安装目录、更新缓存目录），版本、说明照本目录的 package.json。
// - app/dist/main.cjs：壳的主进程，连同 electron-updater 打成一个文件（安装包里不用带 node_modules）；electron 本身不打进去。
// - app/dist/runner/hosted.cjs：本机程序（apps/local）的桌面版入口，壳用 utilityProcess 跑它（Electron 自带的 Node；源码照旧只用 node:）。
// - resources/icon.png：256×256 的图标（和托盘「已连接」同一个蓝），electron-builder 拿它出 exe 和安装包的图标。
// 类型检查另跑 tsc --noEmit。
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "app");
const common = { bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "src", "main.ts")], outfile: join(app, "dist", "main.cjs"), external: ["electron"] });
await build({ ...common, entryPoints: [join(root, "..", "local", "src", "hosted.ts")], outfile: join(app, "dist", "runner", "hosted.cjs") });
const dev = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(app, "package.json"), JSON.stringify({
  name: "tianshu-desktop", productName: "天枢", version: dev.version, description: dev.description, author: dev.author, main: "dist/main.cjs",
  // electron-builder 以 app/ 为项目目录，从这里认 Electron 版本
  devDependencies: { electron: dev.devDependencies.electron },
}, null, 2) + "\n");

// 图标：实心圆点（和 src/trayView.ts 的画法一样，这里出 RGBA 的 PNG）
function png(size, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = (size - 1) / 2, radius = size / 2 - 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // 每行开头的过滤类型
    for (let x = 0; x < size; x++) {
      const a = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x - c, y - c)));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = Math.round(255 * a);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0; });
  const crc = (buf) => { let k = 0xffffffff; for (const byte of buf) k = crcTable[(k ^ byte) & 0xff] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8 位 RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
mkdirSync(join(root, "resources"), { recursive: true });
writeFileSync(join(root, "resources", "icon.png"), png(256, "#5B7CFA"));
console.log(`app/（${dev.version}）、resources/icon.png`);
