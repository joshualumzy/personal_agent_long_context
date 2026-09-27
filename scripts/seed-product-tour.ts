import pg from "pg";
import { PostgresMeetingStore } from "../src/meetings/store.js";
import { seedProductTour } from "../src/meetings/tour.js";

// Writes the sample "tour" meeting that explains the Meetings page. Running it
// again puts the tour back to its start, so a demo can be reset.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const tour = await seedProductTour(new PostgresMeetingStore(pool));
  console.log(`Seeded "${tour.title}" (${tour.meetingId}) with ${tour.actions.length} cards.`);
} finally {
  await pool.end();
}
