import type { DbClient } from "@badabhai/db";

/**
 * TEST SUPPORT — seed a worker's STATED trade rungs (Middle Way P5): one profile row and one
 * `worker_profile_skill` row per rung, `trade_level` set — the rows
 * `WorkerSkillsRepository.listStatedTradeLevels` reads. It lives in the match module because the
 * all-candidates search keeps its own directory free of any profile read or write (E2_CHECK
 * item 8); its DB gate seeds rungs through here. Deleting the worker cascades both rows.
 */
export async function seedStatedRungs(
  client: DbClient,
  workerId: string,
  rungs: readonly { skill: string; level: string }[],
): Promise<void> {
  if (rungs.length === 0) return;
  const { sql } = client;
  const [profile] = await sql<{ id: string }[]>`
    INSERT INTO worker_profiles (worker_id, profile_status) VALUES (${workerId}::uuid, 'confirmed')
    RETURNING id`;
  for (const r of rungs) {
    await sql`
      INSERT INTO worker_profile_skill (worker_profile_id, skill_id, source, trade_level, level_confirmed)
      VALUES (${profile!.id}::uuid, ${r.skill}, 'worker_confirmed', ${r.level}, true)`;
  }
}
