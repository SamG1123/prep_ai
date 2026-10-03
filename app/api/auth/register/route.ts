import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { getUsers } from "../../../../lib/mongodb";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (name.length < 2 || name.length > 80) {
      return NextResponse.json({ error: "Enter a name between 2 and 80 characters." }, { status: 400 });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (password.length < 8 || password.length > 128) {
      return NextResponse.json({ error: "Password must be between 8 and 128 characters." }, { status: 400 });
    }
    if (!process.env.MONGODB_URI) {
      return NextResponse.json({ error: "Email authentication is not configured on the server." }, { status: 503 });
    }

    const users = await getUsers();
    if (await users.findOne({ email })) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await users.insertOne({ name, email, passwordHash, createdAt: new Date() });
    return NextResponse.json({ created: true });
  } catch (error: any) {
    if (error?.code === 11000) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    return NextResponse.json({ error: "Unable to create the account." }, { status: 500 });
  }
}
