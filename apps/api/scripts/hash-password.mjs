import { randomBytes, scryptSync } from "node:crypto";

// 生成 CEO_ACCESS_PASSWORD_HASH：node scripts/hash-password.mjs <password>
const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
console.log(`scrypt:${salt}:${scryptSync(password, salt, 32).toString("hex")}`);
