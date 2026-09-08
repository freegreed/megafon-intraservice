import fs from "node:fs/promises";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = await fs.readFile(new URL("../migrations/001_postgresql.sql", import.meta.url), "utf8");
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  console.log("PostgreSQL migration completed successfully");
} finally {
  await client.end().catch(() => {});
}
