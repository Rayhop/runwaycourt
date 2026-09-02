import "./scripts/load-env"
import { createClient } from "@supabase/supabase-js"

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const acc = await db.from("agent_account").select("id,user_id,wallet_address,funds")
  console.log("agent_account rows:", acc.error ? acc.error.message : JSON.stringify(acc.data, null, 2))

  const files = await db.from("files").select("id,name,user_id,data_set_id")
  if (files.error) console.log("files error:", files.error.message)
  else {
    const orphan = files.data.filter((f: any) => !f.user_id)
    const owned = files.data.filter((f: any) => f.user_id)
    console.log(`files: ${files.data.length} total, ${orphan.length} orphan, ${owned.length} owned`)
  }

  const cs = await db.from("court_sessions").select("id,user_id")
  if (!cs.error) {
    const orphan = cs.data.filter((s: any) => !s.user_id)
    console.log(`court_sessions: ${cs.data.length} total, ${orphan.length} orphan`)
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1) })
