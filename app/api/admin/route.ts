import { NextRequest, NextResponse } from "next/server";
import { getAdminSettings, getContributionAudit, getContributionBatches, getQuestions } from "../../../lib/mongodb";
import { requireAdmin } from "../../../lib/admin";

const defaults = {
  duplicateReviewThreshold: 0.82,
  duplicateBlockThreshold: 0.9,
  autoPublishLowRisk: false,
};

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  try {
    const settingsCollection = await getAdminSettings();
    const settings = (await settingsCollection.findOne({ _id: "global" })) || {
      _id: "global" as const,
      ...defaults,
      updatedAt: new Date(),
      updatedBy: admin,
    };
    const [pending, published, rejected, questionCount, audit] = await Promise.all([
      (await getContributionBatches()).countDocuments({ status: "awaiting_review" }),
      (await getContributionAudit()).countDocuments({ action: "published" }),
      (await getContributionAudit()).countDocuments({ action: "rejected" }),
      (await getQuestions()).countDocuments(),
      (await getContributionAudit()).find({}, { projection: { items: 0 } }).sort({ createdAt: -1 }).limit(25).toArray(),
    ]);
    const batches = await (await getContributionBatches()).find({ status: "awaiting_review" }).sort({ updatedAt: -1 }).limit(50).toArray();
    return NextResponse.json({ settings, stats: { pending, published, rejected, questionCount }, batches, audit });
  } catch (error) {
    console.error("Unable to load admin dashboard.", error);
    return NextResponse.json({ error: "Admin dashboard is temporarily unavailable." }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await req.json().catch(() => null);
  const review = Number(body?.duplicateReviewThreshold);
  const block = Number(body?.duplicateBlockThreshold);
  if (!Number.isFinite(review) || !Number.isFinite(block) || review < 0 || block > 1 || review >= block) {
    return NextResponse.json({ error: "Thresholds must be between 0 and 1, with review below block." }, { status: 400 });
  }
  const settings = {
    _id: "global" as const,
    duplicateReviewThreshold: review,
    duplicateBlockThreshold: block,
    autoPublishLowRisk: body?.autoPublishLowRisk === true,
    updatedAt: new Date(),
    updatedBy: admin,
  };
  await (await getAdminSettings()).replaceOne({ _id: "global" }, settings, { upsert: true });
  return NextResponse.json({ settings });
}
