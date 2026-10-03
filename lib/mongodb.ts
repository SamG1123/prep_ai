import { MongoClient, type Collection } from "mongodb";

type ChatSession = {
  _id: string;
  userId: string;
  question: {
    text: string;
    company: string;
    role: string;
    domain: string;
    generatedAnswer: string;
  };
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    createdAt: Date;
  }>;
  userMessageCount: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

type RateLimit = {
  _id: string;
  count: number;
  expiresAt: Date;
};

export type AppUser = {
  _id?: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
};

type MongoState = {
  client: MongoClient;
  ready: Promise<MongoClient>;
};

declare global {
  // eslint-disable-next-line no-var
  var prepAiMongo: MongoState | undefined;
}

function getMongoState() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required for chat persistence.");
  if (global.prepAiMongo) return global.prepAiMongo;

  const client = new MongoClient(uri);
  const ready = client.connect();
  global.prepAiMongo = { client, ready };
  return global.prepAiMongo;
}

export function getMongoClientPromise() {
  return getMongoState().ready;
}

export async function getChatSessions(): Promise<Collection<ChatSession>> {
  const state = getMongoState();
  const client = await state.ready;
  const database = client.db(process.env.MONGODB_DB_NAME || "prep_ai");
  const collection = database.collection<ChatSession>("chat_sessions");
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return collection;
}

export async function getChatRateLimits(): Promise<Collection<RateLimit>> {
  const state = getMongoState();
  const client = await state.ready;
  const database = client.db(process.env.MONGODB_DB_NAME || "prep_ai");
  const collection = database.collection<RateLimit>("chat_rate_limits");
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return collection;
}

export async function getUsers(): Promise<Collection<AppUser>> {
  const state = getMongoState();
  const client = await state.ready;
  const database = client.db(process.env.MONGODB_DB_NAME || "prep_ai");
  const collection = database.collection<AppUser>("users");
  await collection.createIndex({ email: 1 }, { unique: true });
  return collection;
}
