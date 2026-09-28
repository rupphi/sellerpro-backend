// One-off CLI. Password comes from stdin, never from committed source or command args.
import "dotenv/config";
import { db, queue, redis } from "../src/infrastructure/clients";
import { hashPassword } from "../src/common/security";

async function main() {
  const username = process.argv[2]?.toLowerCase();
  if (!username || !/^[a-z0-9_.-]{3,40}$/.test(username)) throw new Error("Provide a valid username.");
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  password = password.replace(/\r?\n$/, "");
  if (password.length < 6 || password.length > 128) throw new Error("Invalid password length.");
  const passwordHash = await hashPassword(password);
  password = "";
  await db.$transaction(async tx => {
    const user = await tx.user.upsert({ where: { username },
      create: { username, passwordHash, role: "ADMIN" },
      update: { passwordHash, role: "ADMIN" },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
  });
  console.log(`Admin provisioned: ${username}. Existing sessions revoked.`);
}
main().catch(() => { console.error("Admin provisioning failed."); process.exitCode = 1; })
  .finally(async () => { await queue.close(); await redis.quit(); await db.$disconnect(); });
