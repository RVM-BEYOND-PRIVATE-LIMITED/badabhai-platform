import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { type Database, invites, type Invite } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Data access for `invites` (ADR-0020). PII-free: opaque code + worker ids only. */
@Injectable()
export class InviteRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: { code: string; inviterWorkerId: string; campaign?: string }): Promise<Invite> {
    const [row] = await this.db
      .insert(invites)
      .values({
        code: input.code,
        inviterWorkerId: input.inviterWorkerId,
        campaign: input.campaign ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to create invite");
    return row;
  }

  async findByCode(code: string): Promise<Invite | undefined> {
    const [row] = await this.db.select().from(invites).where(eq(invites.code, code)).limit(1);
    return row;
  }

  async markClicked(id: string): Promise<void> {
    await this.db
      .update(invites)
      .set({ status: "clicked", updatedAt: new Date() })
      .where(eq(invites.id, id));
  }

  async markAccepted(id: string, invitedWorkerId: string): Promise<boolean> {
    const rows = await this.db
      .update(invites)
      .set({ status: "accepted", invitedWorkerId, updatedAt: new Date() })
      .where(and(eq(invites.id, id), isNull(invites.invitedWorkerId)))
      .returning({ id: invites.id });
    return rows.length > 0;
  }
}
