/**
 * Integration tests for "/settings" (Configurações) — v1.0 Task 6.
 *
 * Two layers, both offline:
 *  1. PURE helpers: `memberPatchFromFormData` (form → repo patch, including
 *     Telegram id validation) and `botStatusLabel` (bot heartbeat copy).
 *  2. `buildSettingsData` + a member-update round-trip running the REAL
 *     `@family-finance/db` repositories against the in-memory fake store
 *     (./fake-supabase.ts), exactly like the server action composes them.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  updateHouseholdMember,
  type AppSupabaseClient,
} from "@family-finance/db";

import {
  buildSettingsData,
  memberPatchFromFormData,
  botStatusLabel,
  THEMES,
} from "../app/(app)/settings/queries.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const ALVARO = "11111111-1111-1111-1111-111111111111";
const KAROL = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

describe("memberPatchFromFormData", () => {
  it("trims the display name and parses the telegram id as a number", () => {
    expect(
      memberPatchFromFormData(
        form({ displayName: "  Karol  ", telegramUserId: " 654321 " }),
      ),
    ).toEqual({ displayName: "Karol", telegramUserId: 654321 });
  });

  it("maps blank fields to null (unset name / unlink telegram)", () => {
    expect(
      memberPatchFromFormData(form({ displayName: "   ", telegramUserId: "" })),
    ).toEqual({ displayName: null, telegramUserId: null });
  });

  it("rejects a non-numeric telegram id with a pt-BR message", () => {
    expect(() =>
      memberPatchFromFormData(form({ displayName: "K", telegramUserId: "abc" })),
    ).toThrow(/ID do Telegram/);
  });

  it("rejects zero, negative and fractional telegram ids", () => {
    for (const bad of ["0", "-5", "1.5"]) {
      expect(() =>
        memberPatchFromFormData(
          form({ displayName: "K", telegramUserId: bad }),
        ),
      ).toThrow(/ID do Telegram/);
    }
  });
});

describe("botStatusLabel", () => {
  it("shows the friendly empty state when the bot never wrote anything", () => {
    expect(botStatusLabel(null)).toBe(
      "O bot ainda não registrou nada por aqui",
    );
  });

  it("shows the last interaction's date/time when there is one", () => {
    const label = botStatusLabel({
      created_at: "2026-06-12T18:30:00Z",
      input_kind: "voice",
      transaction_id: "tx-1",
    });
    // 18:30 UTC = 15:30 in América/São_Paulo.
    expect(label).toBe("Último lançamento pelo bot: 12/06/2026, 15:30 🎙️");
  });
});

describe("THEMES", () => {
  it("offers exactly the two household themes", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["esmeralda", "salvia"]);
  });
});

// ---------------------------------------------------------------------------
// 2. buildSettingsData + member update round-trip on the fake store
// ---------------------------------------------------------------------------

function seedStore(withBotInteractions: boolean): FakeSupabaseStore {
  const seed: FakeDatabaseSeed = {
    household_members: [
      {
        id: "member-alvaro",
        household_id: HOUSEHOLD,
        user_id: ALVARO,
        role: "owner",
        is_active: true,
        display_name: "Álvaro",
        telegram_user_id: 123456,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "member-karol",
        household_id: HOUSEHOLD,
        user_id: KAROL,
        role: "member",
        is_active: true,
        display_name: null,
        telegram_user_id: null,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    ],
    bot_interactions: withBotInteractions
      ? [
          {
            id: "bi-old",
            household_id: HOUSEHOLD,
            channel: "telegram",
            input_kind: "text",
            transaction_id: null,
            created_at: "2026-06-10T09:00:00Z",
            updated_at: "2026-06-10T09:00:00Z",
          },
          {
            id: "bi-new",
            household_id: HOUSEHOLD,
            channel: "telegram",
            input_kind: "voice",
            transaction_id: "tx-1",
            created_at: "2026-06-12T18:30:00Z",
            updated_at: "2026-06-12T18:30:00Z",
          },
        ]
      : [],
  };
  return new FakeSupabaseStore(seed);
}

let store: FakeSupabaseStore;
let client: AppSupabaseClient;

beforeEach(() => {
  store = seedStore(true);
  client = createFakeSupabaseClient(store) as unknown as AppSupabaseClient;
});

describe("buildSettingsData", () => {
  it("loads members (creation order) and the newest bot interaction", async () => {
    const data = await buildSettingsData(client, HOUSEHOLD);
    expect(data.members.map((m) => m.id)).toEqual([
      "member-alvaro",
      "member-karol",
    ]);
    expect(data.lastBotInteraction).toMatchObject({
      created_at: "2026-06-12T18:30:00Z",
      input_kind: "voice",
    });
  });

  it("returns null for the bot heartbeat when there is no interaction yet", async () => {
    const emptyClient = createFakeSupabaseClient(
      seedStore(false),
    ) as unknown as AppSupabaseClient;
    const data = await buildSettingsData(emptyClient, HOUSEHOLD);
    expect(data.lastBotInteraction).toBeNull();
    expect(botStatusLabel(data.lastBotInteraction)).toBe(
      "O bot ainda não registrou nada por aqui",
    );
  });
});

describe("member update round-trip (form → patch → repo → store)", () => {
  it("persists a parsed form patch through updateHouseholdMember", async () => {
    const patch = memberPatchFromFormData(
      form({ displayName: "  Karol  ", telegramUserId: "654321" }),
    );
    await updateHouseholdMember(client, HOUSEHOLD, "member-karol", patch);
    expect(
      store.table("household_members").find((r) => r.id === "member-karol"),
    ).toMatchObject({ display_name: "Karol", telegram_user_id: 654321 });

    // And the settings screen reads the new values back.
    const data = await buildSettingsData(client, HOUSEHOLD);
    expect(data.members.find((m) => m.id === "member-karol")).toMatchObject({
      displayName: "Karol",
      telegramUserId: 654321,
    });
  });

  it("unlinks telegram + clears the name when the form comes blank", async () => {
    const patch = memberPatchFromFormData(
      form({ displayName: "", telegramUserId: "" }),
    );
    await updateHouseholdMember(client, HOUSEHOLD, "member-alvaro", patch);
    expect(
      store.table("household_members").find((r) => r.id === "member-alvaro"),
    ).toMatchObject({ display_name: null, telegram_user_id: null });
  });

  it("an invalid telegram id fails at parse time — nothing touches the store", () => {
    expect(() =>
      memberPatchFromFormData(form({ displayName: "X", telegramUserId: "12x" })),
    ).toThrow(/ID do Telegram/);
    expect(
      store.table("household_members").find((r) => r.id === "member-alvaro"),
    ).toMatchObject({ telegram_user_id: 123456 });
  });
});
