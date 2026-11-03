import { readFile, readdir } from "node:fs/promises";
import { db } from "./db.js";
import { config } from "./config.js";
import { passwordHash } from "./auth.js";
try {
  await db.query(
    "CREATE TABLE IF NOT EXISTS migrations (name VARCHAR(200) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  );
  for (const name of (await readdir("backend/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const [rows]: any = await db.query(
      "SELECT name FROM migrations WHERE name=?",
      [name],
    );
    if (rows.length) continue;
    const sql = await readFile(`backend/migrations/${name}`, "utf8");
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.query(statement);
    await db.query("INSERT INTO migrations(name) VALUES(?)", [name]);
    console.log(`Applied ${name}`);
  }
  for (const [id, email, name] of [
    ["tanish", "tanish@outbox.demo", "Tanish Gupta"],
    ["reviewer", "reviewer@outbox.demo", "Reviewer"],
  ]) {
    await db.query(
      "INSERT IGNORE INTO users(id,email,name,password_hash) VALUES(?,?,?,?)",
      [id, email, name, passwordHash(config.DEMO_PASSWORD)],
    );
  }
  console.log(
    "Database ready; demo identities seeded (existing passwords preserved).",
  );
} finally {
  await db.end();
}
