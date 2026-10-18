import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 用户令牌明文：只在内存里出现，落库前加密。 */
export type FeishuTokenSecret = { accessToken: string; refreshToken?: string };

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM：base64(iv | tag | 密文)；附加数据绑定 person_id，密文挪到别人名下解不开。 */
export function encryptTokenSecret(key: Buffer, personId: string, secret: FeishuTokenSecret): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(personId, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptTokenSecret(key: Buffer, personId: string, ciphertext: string): FeishuTokenSecret {
  const raw = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(personId, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as FeishuTokenSecret;
}
