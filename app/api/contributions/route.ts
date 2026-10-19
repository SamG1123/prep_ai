import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAdminSettings, getContributionBatches, getQuestions, type ContributionItem } from "../../../lib/mongodb";
import { ensureSeedQuestions } from "../../../lib/question-store";
import { hashQuestion, questionTokens, tokenSimilarity } from "../../../lib/question-utils";
import { createEmbedding, preprocessQuestion } from "../../../lib/preprocessing";
import { cosineSimilarity } from "../../../lib/question-utils";
import { requireReviewerOrAdmin } from "../../../lib/admin";

const MAX_ITEMS = 100;
const statuses = ["uploaded", "preprocessing", "duplicate_checking", "awaiting_review", "published", "failed"] as const;

function isStatus(value: unknown): value is (typeof statuses)[number] {
  return typeof value === "string" && statuses.includes(value as (typeof statuses)[number]);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const company = String(body?.company || "").trim();
  const role = String(body?.role || "").trim();
  const sourceType = ["text", "csv", "xlsx", "txt"].includes(body?.sourceType) ? body.sourceType : "text";
  const rawItems: unknown[] = Array.isArray(body?.questions) ? body.questions : [];
  if (!company) return NextResponse.json({ error: "Company name is required." }, { status: 400 });
  if (!rawItems.length || rawItems.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Submit between 1 and ${MAX_ITEMS} questions per batch.` }, { status: 400 });
  }
  const originals = rawItems.map((item: unknown) => {
    const value = typeof item === "string" ? item : (item as { text?: unknown })?.text;
    return {
      text: String(value || "").trim(),
      domain: typeof item === "object" && item ? String((item as { domain?: unknown }).domain || "").trim() : "",
      tags: typeof item === "object" && item && Array.isArray((item as { tags?: unknown }).tags)
        ? (item as { tags: unknown[] }).tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean)
        : [],
    };
  }).filter((item: { text: string }) => item.text);
  if (!originals.length) return NextResponse.json({ error: "Add at least one non-empty question." }, { status: 400 });

  const batchId = randomUUID();
  const now = new Date();
  const batches = await getContributionBatches();
  await batches.insertOne({
    _id: batchId,
    sourceType,
    fileName: String(body?.fileName || "").trim() || undefined,
    company,
    role,
    status: "uploaded",
    items: [],
    createdAt: now,
    updatedAt: now,
  });

  try {
    await batches.updateOne({ _id: batchId }, { $set: { status: "preprocessing", updatedAt: new Date() } });
    const processed: ContributionItem[] = [];
    for (const original of originals) {
      try {
        const normalized = await preprocessQuestion({
          originalText: original.text,
          company,
          role,
          domain: original.domain,
          tags: original.tags,
        });
        processed.push({
          ...normalized,
          exactDuplicate: false,
          similarityScore: 0,
          reviewStatus: "pending",
        });
      } catch (error) {
        processed.push({
          originalText: original.text,
          question: original.text,
          company,
          role,
          domain: original.domain,
          tags: original.tags,
          preprocessingStatus: "failed",
          exactDuplicate: false,
          similarityScore: 0,
          reviewNote: error instanceof Error ? error.message : "Preprocessing failed.",
        });
      }
    }
    await batches.updateOne({ _id: batchId }, { $set: { status: "duplicate_checking", items: processed, updatedAt: new Date() } });
    await ensureSeedQuestions();
    const configuredSettings = await (await getAdminSettings()).findOne({ _id: "global" });
    const duplicateReviewThreshold = configuredSettings?.duplicateReviewThreshold ?? 0.82;
    const duplicateBlockThreshold = configuredSettings?.duplicateBlockThreshold ?? 0.9;
    const questionCollection = await getQuestions();
    const questions = await questionCollection.find({}, { projection: { _id: 1, question: 1, questionHash: 1, searchTokens: 1, company: 1, embedding: 1 } }).toArray();
    for (const item of processed) {
      if (item.preprocessingStatus === "failed") continue;
      const hash = hashQuestion(item.question);
      const exact = questions.find((question) => question.questionHash === hash);
      const candidates = questions.map((question) => {
        const score = tokenSimilarity(questionTokens(item.question), question.searchTokens || questionTokens(question.question));
        return { question, score };
      }).sort((left, right) => right.score - left.score);
      if (process.env.GEMINI_API_KEY && candidates.length) {
        try {
          const embedding = await createEmbedding(item.question);
          if (embedding) {
            for (const candidate of candidates.slice(0, 5)) {
              const candidateEmbedding = candidate.question.embedding || await createEmbedding(candidate.question.question);
              if (candidateEmbedding) {
                candidate.score = cosineSimilarity(embedding, candidateEmbedding);
                if (!candidate.question.embedding) {
                  await questionCollection.updateOne({ _id: candidate.question._id }, { $set: { embedding: candidateEmbedding } });
                }
              }
            }
            candidates.sort((left, right) => right.score - left.score);
          }
        } catch (error) {
          console.warn("Semantic embedding check unavailable; using token similarity.", error);
        }
      }
      const nearest = candidates[0];
      item.exactDuplicate = Boolean(exact);
      item.similarityScore = nearest?.score || 0;
      if (exact) item.reviewNote = "Exact normalized duplicate. It cannot be published as a new question.";
      else if ((nearest?.score || 0) > duplicateBlockThreshold) item.reviewNote = "High similarity match. Keep out of the canonical bank.";
      else if ((nearest?.score || 0) >= duplicateReviewThreshold) item.reviewNote = "Similarity is in the review range.";
      if (nearest && nearest.score >= duplicateReviewThreshold) {
        item.nearestMatch = {
          id: String(nearest.question._id),
          question: nearest.question.question,
          company: nearest.question.company,
          score: nearest.score,
        };
      }
    }
    await batches.updateOne({ _id: batchId }, { $set: { status: "awaiting_review", items: processed, updatedAt: new Date() } });
    return NextResponse.json({ batchId, status: "awaiting_review", items: processed }, { status: 201 });
  } catch (error) {
    await batches.updateOne({ _id: batchId }, { $set: { status: "failed", error: error instanceof Error ? error.message : "Contribution failed.", updatedAt: new Date() } });
    return NextResponse.json({ error: "Contribution processing failed.", batchId }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!(await requireReviewerOrAdmin())) return NextResponse.json({ error: "Reviewer access is required." }, { status: 403 });
  const statusParam = new URL(req.url).searchParams.get("status");
  if (statusParam && !isStatus(statusParam)) return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  const status = statusParam && isStatus(statusParam) ? statusParam : undefined;
  try {
    const batches = await getContributionBatches();
    const items = await batches.find(status ? { status } : {}).sort({ updatedAt: -1 }).limit(50).toArray();
    return NextResponse.json({ batches: items });
  } catch (error) {
    console.error("Unable to load contribution batches.", error);
    return NextResponse.json({ error: "Contribution review queue is unavailable." }, { status: 503 });
  }
}
