import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const migrationsDirectory = fileURLToPath(new URL("../database/migrations/", import.meta.url));
const migrations = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();
const client = new pg.Client({ connectionString: databaseUrl });

await client.connect();
try {
  for (const migration of migrations) {
    await client.query(await readFile(`${migrationsDirectory}${migration}`, "utf8"));
    console.log(`Applied ${migration}`);
  }
} finally {
  await client.end();
}
