import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../auth";
import { getContributionBatches, getQuestions } from "../../../../lib/mongodb";
import { hashQuestion, normalizeQuestion, questionTokens } from "../../../../lib/question-utils";

function isReviewer(email: string) {
  return (process.env.REVIEWER_EMAILS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

async function requireReviewer() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email?.trim();
  return email && isReviewer(email) ? email : null;
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ batchId: string }> },
) {
  const reviewer = await requireReviewer();
  if (!reviewer) return NextResponse.json({ error: "Reviewer access is required." }, { status: 403 });
  const { batchId } = await context.params;
  const body = await req.json().catch(() => null);
  const batches = await getContributionBatches();
  const batch = await batches.findOne({ _id: batchId });
  if (!batch) return NextResponse.json({ error: "Contribution batch not found." }, { status: 404 });

  const action = String(body?.action || "");
  if (action === "reject") {
    await batches.updateOne({ _id: batchId }, {
      $set: { status: "failed", error: "Rejected by reviewer.", updatedAt: new Date() },
    });
    return NextResponse.json({ status: "failed" });
  }
  if (action === "edit") {
    const index = Number(body?.index);
    const item = batch.items[index];
    if (!item || typeof body?.question !== "string") return NextResponse.json({ error: "A valid item and question are required." }, { status: 400 });
    item.question = body.question.trim();
    item.domain = String(body.domain || item.domain).trim();
    item.tags = Array.isArray(body.tags) ? body.tags.filter((tag: unknown): tag is string => typeof tag === "string").map((tag: string) => tag.trim()).filter(Boolean) : item.tags;
    item.reviewNote = "Edited by reviewer.";
    await batches.updateOne({ _id: batchId }, { $set: { items: batch.items, updatedAt: new Date() } });
    return NextResponse.json({ status: batch.status, item });
  }
  if (action !== "publish") return NextResponse.json({ error: "Action must be publish, edit, or reject." }, { status: 400 });

  const indexes = Array.isArray(body?.indexes) ? body.indexes.map((value: unknown) => Number(value)).filter(Number.isInteger) : [];
  if (!indexes.length) return NextResponse.json({ error: "Select at least one contribution to publish." }, { status: 400 });
  const selected = indexes.map((index: number) => batch.items[index]).filter(Boolean);
  if (selected.some((item: typeof batch.items[number]) => item.preprocessingStatus === "failed" || item.exactDuplicate || item.similarityScore > 0.9)) {
    return NextResponse.json({ error: "Exact and high-similarity duplicates, and failed preprocessing items, cannot be published." }, { status: 409 });
  }

  const questions = await getQuestions();
  const highest = await questions.findOne({}, { sort: { sl_no: -1 } });
  let nextNumber = Number(highest?.sl_no || 0) + 1;
  const now = new Date();
  try {
    for (const item of selected) {
      const normalized = normalizeQuestion(item.question);
      await questions.insertOne({
        _id: `contribution-${batchId}-${nextNumber}`,
        sl_no: nextNumber,
        question: item.question,
        company: item.company,
        role: item.role,
        domains: item.domain ? [item.domain] : [],
        tags: item.tags,
        difficulty: item.difficulty,
        questionNormalized: normalized,
        questionHash: hashQuestion(item.question),
        searchTokens: questionTokens(item.question),
        source: "contribution",
        createdAt: now,
        updatedAt: now,
      });
      nextNumber += 1;
    }
    const published = new Set(indexes);
    batch.items = batch.items.map((item, index) =>
      published.has(index) ? { ...item, reviewNote: "Published." } : item,
    );
    await batches.updateOne({ _id: batchId }, { $set: { status: "published", items: batch.items, updatedAt: new Date() } });
    return NextResponse.json({ status: "published", publishedCount: selected.length });
  } catch (error) {
    console.error("Unable to publish contribution.", error);
    return NextResponse.json({ error: "Unable to publish selected questions. No further items were processed." }, { status: 500 });
  }
}
