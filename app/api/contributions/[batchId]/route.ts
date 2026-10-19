import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../auth";
import { getContributionAudit, getContributionBatches, getQuestions } from "../../../../lib/mongodb";
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
    await (await getContributionAudit()).insertOne({
      batchId,
      action: "rejected",
      reviewerEmail: reviewer,
      company: batch.company,
      role: batch.role,
      items: batch.items.map((item) => ({ ...item, reviewStatus: "rejected", reviewNote: "Rejected by reviewer." })),
      createdAt: new Date(),
    });
    await batches.deleteOne({ _id: batchId });
    return NextResponse.json({ status: "deleted", logged: true });
  }
  if (action === "approve" || action === "reject_item") {
    const index = Number(body?.index);
    const item = batch.items[index];
    if (!item) return NextResponse.json({ error: "A valid contribution item is required." }, { status: 400 });
    if (action === "approve" && (item.preprocessingStatus === "failed" || item.exactDuplicate || item.similarityScore > 0.9)) {
      return NextResponse.json({ error: "This contribution is blocked by preprocessing or duplicate checks." }, { status: 409 });
    }
    item.reviewStatus = action === "approve" ? "approved" : "rejected";
    item.reviewNote = action === "approve" ? "Approved by reviewer." : "Rejected by reviewer.";
    if (action === "reject_item") {
      await (await getContributionAudit()).insertOne({
        batchId,
        action: "rejected",
        reviewerEmail: reviewer,
        company: item.company,
        role: item.role,
        items: [item],
        createdAt: new Date(),
      });
      batch.items.splice(index, 1);
      if (!batch.items.length) {
        await batches.deleteOne({ _id: batchId });
        return NextResponse.json({ status: "deleted", logged: true });
      }
      await batches.updateOne({ _id: batchId }, { $set: { items: batch.items, updatedAt: new Date() } });
      return NextResponse.json({ status: "awaiting_review", deleted: true, item });
    }
    await batches.updateOne({ _id: batchId }, { $set: { items: batch.items, updatedAt: new Date() } });
    return NextResponse.json({ status: batch.status, item });
  }
  if (action === "edit") {
    const index = Number(body?.index);
    const item = batch.items[index];
    if (!item || typeof body?.question !== "string") return NextResponse.json({ error: "A valid item and question are required." }, { status: 400 });
    item.question = body.question.trim();
    item.company = typeof body.company === "string" ? body.company.trim() : item.company;
    item.role = typeof body.role === "string" ? body.role.trim() : item.role;
    item.domain = typeof body.domain === "string" ? body.domain.trim() : item.domain;
    item.difficulty = typeof body.difficulty === "string" ? body.difficulty.trim() : item.difficulty;
    item.tags = Array.isArray(body.tags)
      ? body.tags.filter((tag: unknown): tag is string => typeof tag === "string").map((tag: string) => tag.trim()).filter(Boolean)
      : item.tags;
    if (!item.company || !item.question) {
      return NextResponse.json({ error: "Company and question are required." }, { status: 400 });
    }
    const existingQuestion = await (await getQuestions()).findOne({
      questionHash: hashQuestion(item.question),
    });
    item.exactDuplicate = Boolean(existingQuestion);
    item.similarityScore = 0;
    item.nearestMatch = undefined;
    item.reviewStatus = "pending";
    item.reviewNote = "Edited by reviewer.";
    await batches.updateOne({ _id: batchId }, { $set: { items: batch.items, updatedAt: new Date() } });
    return NextResponse.json({ status: batch.status, item });
  }
  if (action !== "publish") return NextResponse.json({ error: "Action must be publish, edit, or reject." }, { status: 400 });

  const indexes = Array.isArray(body?.indexes) ? body.indexes.map((value: unknown) => Number(value)).filter(Number.isInteger) : [];
  if (!indexes.length) return NextResponse.json({ error: "Select at least one contribution to publish." }, { status: 400 });
  const selected = indexes.map((index: number) => batch.items[index]).filter(Boolean);
  if (selected.some((item: typeof batch.items[number]) => item.reviewStatus !== "approved" || item.preprocessingStatus === "failed" || item.exactDuplicate || item.similarityScore > 0.9)) {
    return NextResponse.json({ error: "Only approved, successfully preprocessed, non-duplicate items can be published." }, { status: 409 });
  }

  const questions = await getQuestions();
  const highest = await questions.findOne({}, { sort: { sl_no: -1 } });
  let nextNumber = Number(highest?.sl_no || 0) + 1;
  const now = new Date();
  try {
    const duplicateHashes = await Promise.all(
      selected.map((item: typeof batch.items[number]) => questions.findOne({ questionHash: hashQuestion(item.question) })),
    );
    if (duplicateHashes.some(Boolean)) {
      return NextResponse.json({ error: "A selected question is already in the live question bank." }, { status: 409 });
    }
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
    const publishedItems = selected.map((item: typeof batch.items[number]) => ({ ...item, reviewStatus: "approved" as const, reviewNote: "Published." }));
    await (await getContributionAudit()).insertOne({
      batchId,
      action: "published",
      reviewerEmail: reviewer,
      company: batch.company,
      role: batch.role,
      items: publishedItems,
      createdAt: new Date(),
    });
    const remainingItems = batch.items.filter((_item, index) => !published.has(index));
    if (!remainingItems.length) {
      await batches.deleteOne({ _id: batchId });
      return NextResponse.json({ status: "deleted", logged: true, publishedCount: selected.length });
    }
    await batches.updateOne({ _id: batchId }, { $set: { status: "awaiting_review", items: remainingItems, updatedAt: new Date() } });
    return NextResponse.json({ status: "awaiting_review", logged: true, publishedCount: selected.length });
  } catch (error) {
    console.error("Unable to publish contribution.", error);
    return NextResponse.json({ error: "Unable to publish selected questions. No further items were processed." }, { status: 500 });
  }
}
