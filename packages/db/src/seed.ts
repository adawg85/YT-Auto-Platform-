/** Idempotent dev seed: one channel + DNA + three ideas. */
import { createDb } from "./client";
import { channelDna, channels, ideas } from "./schema";

const db = createDb();

const CHANNEL_ID = "01SEEDCHANNEL0000000000000";

await db
  .insert(channels)
  .values({
    id: CHANNEL_ID,
    name: "Everyday Physics",
    handle: "@everyday-physics-shorts",
    niche: "counterintuitive physics of daily life",
    autonomyTier: 0,
  })
  .onConflictDoNothing();

await db
  .insert(channelDna)
  .values({
    id: "01SEEDDNA00000000000000000",
    channelId: CHANNEL_ID,
    tone: "curious, punchy, no jargon; explains like a sharp friend",
    audiencePersona: "commuters 18-45 who like 'today I learned' content",
    hookStyles: ["curiosity_gap", "stakes_first", "contrarian"],
    forbiddenTopics: ["health advice", "financial advice", "politics"],
    visualStyle: {
      primaryColor: "#38bdf8",
      font: "Inter",
      imageStyle: "clean flat illustration, high contrast, single focal object",
    },
    voiceId: "mock-voice-1",
    ctaTemplate: "Follow for one surprising fact every day.",
    targetLengthSec: 40,
    cadencePerWeek: 5,
  })
  .onConflictDoNothing();

const seedIdeas = [
  {
    id: "01SEEDIDEA0000000000000001",
    title: "Why hot water can freeze faster than cold water",
    angle: "The Mpemba effect — a fridge experiment scientists still argue about.",
  },
  {
    id: "01SEEDIDEA0000000000000002",
    title: "Your shower curtain attacks you on purpose (physics of it)",
    angle: "The billow is a pressure vortex — Bernoulli in your bathroom.",
  },
  {
    id: "01SEEDIDEA0000000000000003",
    title: "Why airplane windows are round",
    angle: "Square windows literally tore planes apart in the 1950s.",
  },
];

for (const idea of seedIdeas) {
  await db
    .insert(ideas)
    .values({ ...idea, channelId: CHANNEL_ID, sourceType: "manual" })
    .onConflictDoNothing();
}

console.log(`Seeded channel ${CHANNEL_ID} with ${seedIdeas.length} ideas.`);
process.exit(0);
