import crypto from "node:crypto";
import { env } from "../config.js";

const algorithm = "aes-256-gcm";

function key(): Buffer | null {
  if (!env.FIELD_ENCRYPTION_KEY || env.FIELD_ENCRYPTION_KEY.length < 32) return null;
  return crypto.createHash("sha256").update(env.FIELD_ENCRYPTION_KEY).digest();
}

export function encryptField(value: string | null | undefined): string | null {
  if (!value) return null;
  const derived = key();
  if (!derived) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, derived, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptField(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("enc:")) return value;
  const derived = key();
  if (!derived) return value;
  const [, iv, tag, payload] = value.split(":");
  if (!iv || !tag || !payload) return null;
  const decipher = crypto.createDecipheriv(algorithm, derived, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, "base64")),
    decipher.final()
  ]).toString("utf8");
}
