// Zero-dependency Node data cloner for migrating between Atlas clusters.
import "../engram-retrieval/src/env.js";
import { MongoClient } from "mongodb";

const sourceUri = process.env.MONGODB_URI_OLD;
const targetUri = process.env.MONGODB_URI_NEW;
const dbName = process.env.MONGODB_DATABASE || "engram";

if (!sourceUri || !targetUri) {
  console.error("Missing MONGODB_URI_OLD or MONGODB_URI_NEW in environment.");
  process.exit(1);
}

const source = new MongoClient(sourceUri);
const target = new MongoClient(targetUri);

try {
  await Promise.all([source.connect(), target.connect()]);
  const sDb = source.db(dbName);
  const tDb = target.db(dbName);

  const collections = await sDb.listCollections().toArray();
  console.log(`Cloning ${collections.length} collection(s) from OLD (${dbName}) to NEW (${dbName})...\n`);

  for (const info of collections) {
    if (info.name.startsWith("system.") || info.type === "view") continue;
    const name = info.name;
    const count = await sDb.collection(name).countDocuments();
    process.stdout.write(`  ${name.padEnd(26)} (${String(count).padStart(4)} docs)... `);

    const exists = (await tDb.listCollections({ name }).toArray()).length > 0;
    if (!exists) {
      const opts = info.options ? { ...info.options } : {};
      await tDb.createCollection(name, opts).catch(() => {});
    }

    if (count > 0) {
      const docs = await sDb.collection(name).find({}).toArray();
      await tDb.collection(name).insertMany(docs, { ordered: false }).catch(err => {
        if (!err.message.includes("E11000")) console.error(` [insert error: ${err.message}]`);
      });
    }

    // Copy indexes (excluding default _id)
    const indexes = await sDb.collection(name).indexes().catch(() => []);
    for (const idx of indexes) {
      if (idx.name === "_id_") continue;
      const { v, ns, ...options } = idx;
      await tDb.collection(name).createIndex(idx.key, options).catch(() => {});
    }

    console.log("OK");
  }

  console.log("\nClone complete! Run npm run schema:migrate-verify -- --deep to verify.");
} finally {
  await Promise.allSettled([source.close(), target.close()]);
}
