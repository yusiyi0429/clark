// 读主工作区 apps/api/.env 里的模型网关配置。只在内存里用，不打印、不写盘。
import { readFileSync } from 'node:fs';

const ENV_FILE = 'C:/Users/10021/Desktop/clark/Tianshu-MVP/apps/api/.env';
const values = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

export const gateway = {
  responsesUrl: values.PI_BASE_URL.replace(/\/+$/, ''),
  root: values.PI_BASE_URL.replace(/\/+$/, '').replace(/\/responses$/, ''),
  apiKey: values.PI_API_KEY,
  light: values.LIGHT_MODEL,
  heavy: values.HEAVY_MODEL,
  compaction: values.COMPACTION_MODEL,
};
