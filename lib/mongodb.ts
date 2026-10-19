import { MongoClient, type Collection } from "mongodb";

export type ChatSession = {
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

export type QuestionDocument = {
  _id?: string;
  sl_no: number | string;
  question: string;
  company: string;
  role: string;
  domains: string[];
  tags?: string[];
  difficulty?: string;
  questionNormalized?: string;
  questionHash?: string;
  searchTokens?: string[];
  embedding?: number[];
  source?: "seed" | "contribution";
  createdAt?: Date;
  updatedAt?: Date;
};

export type ContributionStatus =
  | "uploaded"
  | "preprocessing"
  | "duplicate_checking"
  | "awaiting_review"
  | "published"
  | "failed";

export type ContributionItem = {
  originalText: string;
  question: string;
  company: string;
  role: string;
  domain: string;
  tags: string[];
  difficulty?: string;
  preprocessingStatus: "successful" | "needs_review" | "failed";
  reviewStatus?: "pending" | "approved" | "rejected";
  exactDuplicate: boolean;
  similarityScore: number;
  nearestMatch?: {
    id: string;
    question: string;
    company: string;
    score: number;
  };
  reviewNote?: string;
};

export type ContributionBatch = {
  _id: string;
  contributorId?: string;
  sourceType: "text" | "csv" | "xlsx" | "txt";
  fileName?: string;
  company: string;
  role: string;
  status: ContributionStatus;
  items: ContributionItem[];
  createdAt: Date;
  updatedAt: Date;
  error?: string;
};

export type ContributionAudit = {
  _id?: string;
  batchId: string;
  action: "published" | "rejected";
  reviewerEmail: string;
  company: string;
  role: string;
  items: ContributionItem[];
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

  const client = new MongoClient(uri, {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
  });
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

export async function getQuestions(): Promise<Collection<QuestionDocument>> {
  const state = getMongoState();
  const client = await state.ready;
  const database = client.db(process.env.MONGODB_DB_NAME || "prep_ai");
  const collection = database.collection<QuestionDocument>("questions");
  await collection.createIndex({ questionHash: 1 }, { unique: true, sparse: true });
  await collection.createIndex({ company: 1, domains: 1 });
  return collection;
}

export async function getContributionBatches(): Promise<Collection<ContributionBatch>> {
  const state = getMongoState();
  const client = await state.ready;
  const database = client.db(process.env.MONGODB_DB_NAME || "prep_ai");
  const collection = database.collection<ContributionBatch>("contribution_batches");
  await collection.createIndex({ status: 1, updatedAt: -1 });
  await collection.createIndex({ contributorId: 1, createdAt: -1 });
  return collection;
}

export async function getContributionAudit(): Promise<Collection<ContributionAudit>> {
  const state = getMongoState();
  const client = await state.ready;
  const database = client.db(process.env.MONGODB_DB_NAME || "prep_ai");
  const collection = database.collection<ContributionAudit>("contribution_audit");
  await collection.createIndex({ batchId: 1, createdAt: -1 });
  await collection.createIndex({ createdAt: -1 });
  return collection;
}
