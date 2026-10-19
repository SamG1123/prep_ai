import { getServerSession } from "next-auth";
import { authOptions } from "../auth";

function configuredReviewerEmails() {
  return (process.env.REVIEWER_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export async function getAuthorizedEmail() {
  const session = await getServerSession(authOptions);
  return session?.user?.email?.trim().toLowerCase() || null;
}

export function isAdminEmail(email: string) {
  return configuredReviewerEmails().includes(email);
}

export function isReviewerEmail(email: string) {
  return configuredReviewerEmails().includes(email);
}

export async function requireAdmin() {
  const email = await getAuthorizedEmail();
  return email && isAdminEmail(email) ? email : null;
}

export async function requireReviewerOrAdmin() {
  const email = await getAuthorizedEmail();
  return email && isReviewerEmail(email) ? email : null;
}
