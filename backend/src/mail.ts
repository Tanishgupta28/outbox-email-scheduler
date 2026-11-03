import nodemailer from "nodemailer";
import { config } from "./config.js";
import type { Email } from "./db.js";
const transport =
  config.MAIL_TRANSPORT === "ethereal"
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        requireTLS: true,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      })
    : null;
export async function deliver(email: Email): Promise<string | null> {
  if (!transport) {
    if (email.recipient === "fail@example.com")
      throw new Error("Simulated SMTP rejection");
    await new Promise((r) => setTimeout(r, 50));
    return null;
  }
  if (!config.SMTP_USER || !config.SMTP_PASS)
    throw new Error("Ethereal credentials are missing");
  const info = await transport.sendMail({
    from: config.MAIL_FROM,
    to: email.recipient,
    subject: email.subject,
    text: email.body,
    messageId: `<${email.id}@outbox.example>`,
  });
  if (!info.accepted?.length)
    throw new Error("SMTP did not accept the recipient");
  return nodemailer.getTestMessageUrl(info) || null;
}
