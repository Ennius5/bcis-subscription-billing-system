import { count, eq } from "drizzle-orm";
import {
  areaCreateSchema,
  collectorCreateSchema,
  planCreateSchema,
  serviceAccountCreateSchema,
  servicePlanChangeSchema,
  serviceRateChangeSchema,
  serviceStatusChangeSchema,
  serviceSuspendSchema,
  subscriberCreateSchema,
  type ServiceTypeCode,
} from "@bcis/shared";
import { createArea, createCollector, listAreas, listCollectors } from "../collection/service";
import { loadConfig } from "../config";
import { createPlan, listPlans } from "../plans/service";
import { suspendService } from "../receivables/suspensions";
import {
  changeServicePlan,
  changeServiceRate,
  changeServiceStatus,
  createServiceAccount,
} from "../service-accounts/service";
import { createSubscriber } from "../subscribers/service";
import { createDb, type Db } from "./client";
import { subscribers, users } from "./schema";

/*
 * Demo dataset (spec section 8): 3 areas, 2 collectors, 7 plans (3 Internet, 2 Cable,
 * 2 Combo), 50 subscribers and 63 service accounts in mixed states.
 *
 * Everything goes through the normal services, so each record gets its audit rows and
 * service history exactly as if a clerk had entered it. All names, numbers and emails are
 * synthetic: phone numbers use the 0999 000 xxxx range and emails use example.com.
 *
 * Safe to run twice: plans, areas and collectors are reused by code, and subscribers are
 * only created when no seeded subscriber exists yet (they are marked by DEMO_NOTE).
 * The random choices come from a fixed seed, so every run produces the same dataset.
 */

const DEMO_NOTE = "Demo seed data";
const ACTOR_USERNAME = "demo_admin";
const SUBSCRIBER_COUNT = 50;

const PLANS: ReadonlyArray<{
  code: string;
  name: string;
  serviceType: ServiceTypeCode;
  priceCentavos: number;
  speedMbps?: number;
  channelCount?: number;
}> = [
  { code: "INET-25", name: "Internet 25 Mbps", serviceType: "internet", priceCentavos: 99_900, speedMbps: 25 },
  { code: "INET-50", name: "Internet 50 Mbps", serviceType: "internet", priceCentavos: 149_900, speedMbps: 50 },
  { code: "INET-100", name: "Internet 100 Mbps", serviceType: "internet", priceCentavos: 199_900, speedMbps: 100 },
  { code: "CABLE-BASIC", name: "Cable Basic", serviceType: "cable", priceCentavos: 45_000, channelCount: 60 },
  { code: "CABLE-PLUS", name: "Cable Plus", serviceType: "cable", priceCentavos: 65_000, channelCount: 120 },
  {
    code: "COMBO-25",
    name: "Combo 25 Mbps + Cable Basic",
    serviceType: "combo",
    priceCentavos: 129_900,
    speedMbps: 25,
    channelCount: 60,
  },
  {
    code: "COMBO-50",
    name: "Combo 50 Mbps + Cable Plus",
    serviceType: "combo",
    priceCentavos: 189_900,
    speedMbps: 50,
    channelCount: 120,
  },
];

const AREAS = [
  { code: "ZONE-N", name: "North Maramag", barangays: ["Dologon", "Panalsalan", "Anahawon", "Kiharong"] },
  { code: "ZONE-C", name: "Central Maramag", barangays: ["North Poblacion", "South Poblacion", "Base Camp"] },
  { code: "ZONE-S", name: "South Maramag", barangays: ["Camp 1", "Dagumba-an", "Kuya", "Lantay", "San Roque"] },
] as const;

// Two collectors share three areas: COL-01 walks North and Central, COL-02 walks South.
const COLLECTORS = [
  { code: "COL-01", fullName: "Rodel Demo Collector", areas: ["ZONE-N", "ZONE-C"] },
  { code: "COL-02", fullName: "Marites Demo Collector", areas: ["ZONE-S"] },
] as const;

const FIRST_NAMES = [
  "Andres", "Bea", "Carlo", "Daisy", "Emil", "Fe", "Gilbert", "Hazel", "Isagani", "Joy",
  "Karlo", "Liza", "Manny", "Nena", "Oscar", "Precy", "Quintin", "Rosa", "Samuel", "Tess",
  "Ulysses", "Vilma", "Wilfredo", "Xyza", "Yolly", "Zaldy", "Arnel", "Belen", "Cesar", "Dolor",
];
const LAST_NAMES = [
  "Abalos", "Bacani", "Cabahug", "Dagohoy", "Estrada", "Fajardo", "Gamboa", "Habagat", "Ilagan", "Jumawan",
  "Katigbak", "Lagumbay", "Magbanua", "Nacua", "Ocampo", "Pabualan", "Quimpo", "Ramirez", "Sabalo", "Tabanao",
];
const BILLING_DAYS = [1, 5, 10, 15, 20, 25];

/** Small deterministic PRNG (mulberry32), so the dataset is the same on every run. */
function prng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

/** A calendar date `days` before today, as "YYYY-MM-DD" in local time. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function ensurePlans(db: Db, actorId: string): Promise<Map<string, string>> {
  const existing = new Map((await listPlans(db, { includeInactive: true })).map((p) => [p.code, p.id]));
  for (const plan of PLANS) {
    if (existing.has(plan.code)) continue;
    const created = await createPlan(db, actorId, planCreateSchema.parse(plan));
    existing.set(created.code, created.id);
    console.log(`Created plan ${created.code}.`);
  }
  return existing;
}

async function ensureAreas(db: Db, actorId: string): Promise<Map<string, string>> {
  const existing = new Map((await listAreas(db, { includeInactive: true })).map((a) => [a.code, a.id]));
  for (const area of AREAS) {
    if (existing.has(area.code)) continue;
    const created = await createArea(db, actorId, areaCreateSchema.parse({ code: area.code, name: area.name }));
    existing.set(created.code, created.id);
    console.log(`Created area ${created.code}.`);
  }
  return existing;
}

async function ensureCollectors(db: Db, actorId: string): Promise<Map<string, string>> {
  const existing = new Map((await listCollectors(db, { includeInactive: true })).map((c) => [c.code, c.id]));
  for (const collector of COLLECTORS) {
    if (existing.has(collector.code)) continue;
    const created = await createCollector(
      db,
      actorId,
      collectorCreateSchema.parse({ code: collector.code, fullName: collector.fullName }),
    );
    existing.set(created.code, created.id);
    console.log(`Created collector ${created.code}.`);
  }
  return existing;
}

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data when NODE_ENV=production");
  }

  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const [actor] = await db.select({ id: users.id }).from(users).where(eq(users.username, ACTOR_USERNAME));
    if (!actor) throw new Error(`User "${ACTOR_USERNAME}" not found. Run db:seed-demo first.`);
    const actorId = actor.id;

    const planIds = await ensurePlans(db, actorId);
    const areaIds = await ensureAreas(db, actorId);
    const collectorIds = await ensureCollectors(db, actorId);

    const [seeded] = await db.select({ value: count() }).from(subscribers).where(eq(subscribers.notes, DEMO_NOTE));
    if ((seeded?.value ?? 0) > 0) {
      console.log(`Demo subscribers already exist (${seeded?.value}); leaving them unchanged.`);
      return;
    }

    const rand = prng(20261009);
    const planId = (code: string) => {
      const id = planIds.get(code);
      if (!id) throw new Error(`Plan missing: ${code}`);
      return id;
    };
    const statusChange = (status: string, effectiveDate: string, reason: string) =>
      serviceStatusChangeSchema.parse({ status, effectiveDate, reason });

    const usedNames = new Set<string>();
    const tally = { subscribers: 0, services: 0, pending: 0, active: 0, suspended: 0, terminated: 0 };

    for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
      let fullName: string;
      do fullName = `${rand.pick(FIRST_NAMES)} ${rand.pick(LAST_NAMES)}`;
      while (usedNames.has(fullName));
      usedNames.add(fullName);

      const area = AREAS[i % AREAS.length]!;
      const collector = COLLECTORS.find((c) => (c.areas as readonly string[]).includes(area.code))!;
      const number = String(i + 1).padStart(4, "0");
      const contacts: Array<Record<string, unknown>> = [
        { type: "mobile", value: `0999 000 ${number}`, isPrimary: true },
      ];
      if (i % 3 === 0) {
        const [first, last] = fullName.toLowerCase().split(" ");
        contacts.push({ type: "email", value: `${first}.${last}${i + 1}@example.com` });
      }

      const subscriber = await createSubscriber(
        db,
        actorId,
        subscriberCreateSchema.parse({
          fullName,
          billingDay: rand.pick(BILLING_DAYS),
          collectionAreaId: areaIds.get(area.code),
          assignedCollectorId: collectorIds.get(collector.code),
          notes: DEMO_NOTE,
          address: {
            line1: `Purok ${rand.int(1, 12)}`,
            barangay: rand.pick(area.barangays),
            city: "Maramag",
            province: "Bukidnon",
          },
          contacts,
        }),
      );
      tally.subscribers++;

      // Every subscriber has one service; every fourth also has a second one (63 in all).
      const first = rand.pick(["INET-25", "INET-25", "INET-50", "INET-100", "CABLE-BASIC", "COMBO-25", "COMBO-50"]);
      const codes = i % 4 === 0 ? [first, first.startsWith("CABLE") ? "INET-25" : "CABLE-PLUS"] : [first];

      for (const [n, code] of codes.entries()) {
        const service = await createServiceAccount(
          db,
          actorId,
          subscriber.id,
          serviceAccountCreateSchema.parse({ planId: planId(code), installationAddressId: subscriber.addresses[0]!.id }),
        );
        tally.services++;
        const k = tally.services; // decides this account's story below

        // A few new connections are still waiting for installation.
        if (k % 15 === 0) {
          tally.pending++;
          continue;
        }

        // Most accounts were installed 3 to 8 months ago, so billing has several months to work with.
        const activatedDaysAgo = rand.int(95, 240) - n * 30;
        await changeServiceStatus(
          db,
          actorId,
          service.id,
          statusChange("active", daysAgo(activatedDaysAgo), "Installation completed"),
        );

        if (k % 20 === 7) {
          await changeServiceStatus(db, actorId, service.id, statusChange("terminated", daysAgo(40), "Moved away"));
          tally.terminated++;
          continue;
        }
        if (k % 20 === 13) {
          await suspendService(
            db,
            actorId,
            service.id,
            serviceSuspendSchema.parse({ reason: "Unpaid balance", effectiveDate: daysAgo(20), approvedBy: "Owner" }),
          );
          tally.suspended++;
          continue;
        }
        tally.active++;

        // Some history worth showing: special rates and plan upgrades.
        if (k % 17 === 4) {
          const current = PLANS.find((p) => p.code === code)!.priceCentavos;
          await changeServiceRate(
            db,
            actorId,
            service.id,
            serviceRateChangeSchema.parse({
              rateCentavos: current - 10_000,
              reason: "Senior citizen discount",
              effectiveDate: daysAgo(60),
            }),
          );
        } else if (k % 17 === 9 && code === "INET-25") {
          await changeServicePlan(
            db,
            actorId,
            service.id,
            servicePlanChangeSchema.parse({ planId: planId("INET-50"), reason: "Upgrade request", effectiveDate: daysAgo(45) }),
          );
        }
      }
    }

    console.log(
      `Created ${tally.subscribers} subscribers and ${tally.services} service accounts ` +
        `(${tally.active} active, ${tally.pending} pending, ${tally.suspended} suspended, ${tally.terminated} terminated).`,
    );
    console.log("Demo data seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
