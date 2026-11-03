import "dotenv/config";
import nodemailer from "nodemailer";
import { readFile, writeFile } from "node:fs/promises";
const account = await nodemailer.createTestAccount();
let env = await readFile(".env", "utf8");
for (const [key, value] of Object.entries({
  SMTP_HOST: account.smtp.host,
  SMTP_PORT: String(account.smtp.port),
  SMTP_USER: account.user,
  SMTP_PASS: account.pass,
})) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  env = pattern.test(env) ? env.replace(pattern, line) : `${env}\n${line}\n`;
}
await writeFile(".env", env);
console.log(
  "Ethereal account saved in ignored .env. Restart the worker. Credentials were not printed.",
);
