import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export function passwordHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
}
export function verifyPassword(value: string, hash: string) {
  const [salt, key] = hash.split(":");
  return timingSafeEqual(Buffer.from(key, "hex"), scryptSync(value, salt, 64));
}
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
