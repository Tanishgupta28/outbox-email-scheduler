import mysql, { type RowDataPacket } from "mysql2/promise";
import { config } from "./config.js";
export const db = mysql.createPool({
  uri: config.DATABASE_URL,
  timezone: "Z",
  connectionLimit: 12,
});
export interface Email extends RowDataPacket {
  id: string;
  user_id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_at: Date;
  status: "scheduled" | "processing" | "sent" | "failed";
  attempts: number;
  sent_at: Date | null;
  preview_url: string | null;
  last_error: string | null;
}
export async function emails(
  sql: string,
  params: unknown[] = [],
): Promise<Email[]> {
  const [rows] = await db.query<Email[]>(sql, params);
  return rows;
}
