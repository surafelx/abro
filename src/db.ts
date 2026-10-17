import { Collection, Db, Document, MongoClient } from "mongodb";
import { env } from "./env";

// Tracking data lives in MongoDB (Atlas in production, a local mongod for dev).
// DATABASE_URL is a mongodb:// or mongodb+srv:// URI; the database name comes from the
// URI path, or "abro" when the URI has none.

let db: Db | null = null;

export async function connectDb() {
  const url = env.databaseUrl;
  if (!/^mongodb(\+srv)?:\/\//.test(url)) throw new Error("Set DATABASE_URL to your MongoDB connection string (mongodb+srv://… from Atlas, or mongodb://127.0.0.1:27017/abro locally).");
  const client = new MongoClient(url, { maxPoolSize: 5, serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  const name = new URL(url.replace(/^mongodb(\+srv)?:/, "http:")).pathname.replace(/^\//, "") || "abro";
  db = client.db(name);
  await Promise.all([
    col("days").createIndex({ member: 1, date: 1 }),
    col("todos").createIndex({ done_at: 1 }),
    col("works").createIndex({ member: 1 }),
    col("drafts").createIndex({ member: 1 }),
    col("drafts").createIndex({ status: 1, posted_at: -1 }),
    col("feed_items").createIndex({ day: 1 }),
    col("feed_items").createIndex({ created_at: -1 }),
  ]);
  console.log(`Tracking store: MongoDB (${name})`);
}

export function col<T extends Document = Document>(name: string): Collection<T> {
  if (!db) throw new Error("The database isn't connected yet.");
  return db.collection<T>(name);
}

/** Next number for a collection with readable ids (todos #12, work items, feed items). */
export async function nextId(name: string): Promise<number> {
  const r = await col<{ _id: string; n: number }>("counters").findOneAndUpdate({ _id: name }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after" });
  return r!.n;
}

/** Read without Mongo's _id, so documents keep the plain shapes the rest of the app uses. */
export const NO_ID = { projection: { _id: 0 } } as const;
