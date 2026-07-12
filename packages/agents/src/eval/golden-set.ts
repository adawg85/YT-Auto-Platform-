import {
  PERSONA_ARCHETYPE_LIBRARY,
  type FactualityMode,
  type PersonaDoc,
} from "@ytauto/core";

/**
 * Golden fixture set (#21.2.5 / PROMPT-AUDIT §6): ~6 idea+facts fixtures that
 * exercise the script chain across formats (Shorts + long-form) and rigor
 * modes (strict / balanced / entertainment). Fixtures are FROZEN — scores are
 * only comparable across runs while the inputs stay identical, so edits here
 * invalidate historical comparisons (add fixtures rather than changing them).
 * Facts are real and sourced from the public record; the harness never
 * researches — the fixture IS the research.
 */
export type GoldenFixture = {
  id: string;
  title: string;
  angle: string;
  niche: string;
  contentFormat: "short" | "long";
  targetLengthSec: number;
  factualityMode: FactualityMode;
  tone: string;
  audiencePersona: string;
  hookStyles: string[];
  persona: PersonaDoc;
  verifiedFacts: { id: string; tier: string; text: string }[];
  conjecture: { id: string; tier: string; text: string }[];
};

const seed = (archetype: keyof typeof PERSONA_ARCHETYPE_LIBRARY, niche: string): PersonaDoc =>
  PERSONA_ARCHETYPE_LIBRARY[archetype].seed(niche);

export const GOLDEN_SET: GoldenFixture[] = [
  {
    id: "gimli-glider-long",
    title: "The airliner that ran out of fuel at 41,000 feet",
    angle:
      "Air Canada Flight 143 lost both engines mid-flight over Manitoba because of a metric conversion error — and the captain happened to be a glider pilot.",
    niche: "aviation history",
    contentFormat: "long",
    targetLengthSec: 480,
    factualityMode: "balanced",
    tone: "measured awe, precise, quietly gripping",
    audiencePersona: "aviation enthusiasts who want the full story behind famous incidents",
    hookStyles: ["curiosity_gap", "stakes_first"],
    persona: seed("documentary_narrator", "aviation history"),
    verifiedFacts: [
      {
        id: "gg-1",
        tier: "established",
        text: "On 23 July 1983, Air Canada Flight 143, a Boeing 767, ran out of fuel at 41,000 feet en route from Montreal to Edmonton.",
      },
      {
        id: "gg-2",
        tier: "established",
        text: "The aircraft was refuelled using pounds instead of kilograms — Canada was mid-transition to metric — so it carried roughly half the fuel required.",
      },
      {
        id: "gg-3",
        tier: "established",
        text: "The 767's fuel-quantity indication system was inoperative that day; the fuel load was calculated by hand using dripstick measurements.",
      },
      {
        id: "gg-4",
        tier: "established",
        text: "Captain Bob Pearson was an experienced glider pilot; First Officer Maurice Quintal calculated the descent and chose Gimli, a former RCAF base, as the landing site.",
      },
      {
        id: "gg-5",
        tier: "established",
        text: "Part of the Gimli runway was in use as a drag-racing strip that day, with spectators present; the aircraft landed on the decommissioned runway.",
      },
      {
        id: "gg-6",
        tier: "established",
        text: "The nose gear collapsed on touchdown, but there were no serious injuries among the 61 passengers and 8 crew; the aircraft was repaired and flew for Air Canada until 2008.",
      },
      {
        id: "gg-7",
        tier: "established",
        text: "With both engines out, the 767 lost its main electrical generators; a ram air turbine deployed to power basic flight instruments and hydraulics.",
      },
    ],
    conjecture: [
      {
        id: "gg-c1",
        tier: "reported",
        text: "Pearson is said to have used a gliding technique called a sideslip to bleed off altitude on final approach — a manoeuvre airline passengers would likely never have felt before.",
      },
    ],
  },
  {
    id: "sr71-speedcheck-short",
    title: "The fastest speed check ever recorded",
    angle:
      "The SR-71 Blackbird was so fast that its crews could out-fly missiles — and its records still stand half a century later.",
    niche: "aviation history",
    contentFormat: "short",
    targetLengthSec: 45,
    factualityMode: "balanced",
    tone: "punchy, confident, a little wry",
    audiencePersona: "short-form viewers who love speed and superlatives",
    hookStyles: ["stat_led", "curiosity_gap"],
    persona: seed("enthusiast_expert", "aviation history"),
    verifiedFacts: [
      {
        id: "sr-1",
        tier: "established",
        text: "The Lockheed SR-71 Blackbird set the official jet airspeed record of 3,529.6 km/h (2,193.2 mph) in July 1976 — a record that still stands.",
      },
      {
        id: "sr-2",
        tier: "established",
        text: "The SR-71's airframe was about 92% titanium, and its Pratt & Whitney J58 engines shifted to functioning largely as ramjets at high Mach.",
      },
      {
        id: "sr-3",
        tier: "established",
        text: "Standard evasion procedure when a surface-to-air missile launch was detected was simply to accelerate; no SR-71 was ever lost to enemy action.",
      },
      {
        id: "sr-4",
        tier: "established",
        text: "The fuselage panels were designed with expansion gaps — the aircraft leaked fuel on the ground and sealed up as friction heating expanded the skin at speed.",
      },
    ],
    conjecture: [],
  },
  {
    id: "tacoma-narrows-long",
    title: "The bridge that shook itself apart",
    angle:
      "Tacoma Narrows opened as the third-longest suspension bridge on Earth and collapsed four months later — its failure rewrote engineering itself.",
    niche: "engineering disasters",
    contentFormat: "long",
    targetLengthSec: 420,
    factualityMode: "strict",
    tone: "forensic, exact, unsensational",
    audiencePersona: "viewers who want the real engineering explanation, not drama",
    hookStyles: ["stakes_first"],
    persona: seed("documentary_narrator", "engineering disasters"),
    verifiedFacts: [
      {
        id: "tn-1",
        tier: "established",
        text: "The Tacoma Narrows Bridge opened on 1 July 1940 in Washington State and collapsed on 7 November 1940, about four months later.",
      },
      {
        id: "tn-2",
        tier: "established",
        text: "From opening day the deck moved vertically in wind, earning the nickname 'Galloping Gertie' from construction workers and the public.",
      },
      {
        id: "tn-3",
        tier: "established",
        text: "On the morning of the collapse, wind speeds were around 42 mph and the deck entered a twisting (torsional) oscillation mode it had not shown before.",
      },
      {
        id: "tn-4",
        tier: "established",
        text: "The failure is attributed to aeroelastic flutter — self-exciting torsional oscillation — not simple resonance with wind gusts.",
      },
      {
        id: "tn-5",
        tier: "established",
        text: "The bridge's plate-girder deck was unusually shallow and narrow for its 2,800-foot main span, giving it low torsional stiffness and a solid face to the wind.",
      },
      {
        id: "tn-6",
        tier: "established",
        text: "The only fatality was a cocker spaniel named Tubby, left in a car on the deck; the collapse was filmed and the footage is still used in engineering courses.",
      },
      {
        id: "tn-7",
        tier: "established",
        text: "After the collapse, wind-tunnel aerodynamic testing of deck sections became standard practice for long-span suspension bridge design.",
      },
    ],
    conjecture: [],
  },
  {
    id: "uss-cyclops-short",
    title: "The Navy ship that vanished with 309 people",
    angle:
      "USS Cyclops disappeared without a distress call in 1918 — the US Navy's largest single loss of life outside combat, and still unexplained.",
    niche: "maritime mysteries",
    contentFormat: "short",
    targetLengthSec: 55,
    factualityMode: "balanced",
    tone: "atmospheric, suspenseful, honest about the unknowns",
    audiencePersona: "mystery lovers who respect real evidence",
    hookStyles: ["open_loop", "curiosity_gap"],
    persona: seed("storyteller", "maritime mysteries"),
    verifiedFacts: [
      {
        id: "uc-1",
        tier: "established",
        text: "USS Cyclops, a US Navy collier carrying manganese ore, disappeared after departing Barbados on 4 March 1918 with 309 people aboard.",
      },
      {
        id: "uc-2",
        tier: "established",
        text: "No distress signal was received and no wreckage from Cyclops has ever been identified.",
      },
      {
        id: "uc-3",
        tier: "established",
        text: "It remains the largest single loss of life in US Navy history not directly involving combat.",
      },
      {
        id: "uc-4",
        tier: "established",
        text: "Two of Cyclops's sister ships, Proteus and Nereus, also disappeared in the Atlantic in 1941 while carrying similar heavy ore cargoes.",
      },
    ],
    conjecture: [
      {
        id: "uc-c1",
        tier: "reported",
        text: "A leading modern explanation holds that the heavy manganese ore, denser than the coal the ship was designed for, could have shifted or overstressed the hull in weather, sinking her too fast for a distress call.",
      },
      {
        id: "uc-c2",
        tier: "reported",
        text: "The ship was reportedly overloaded and running with one engine damaged when she left Barbados.",
      },
    ],
  },
  {
    id: "octopus-hearts-short",
    title: "Why octopuses have three hearts",
    angle:
      "An octopus's blood is blue, two of its hearts stop when it swims, and that's why it prefers to crawl — biology's weirdest circulatory system.",
    niche: "amazing animal facts",
    contentFormat: "short",
    targetLengthSec: 40,
    factualityMode: "entertainment",
    tone: "playful, delighted, fast",
    audiencePersona: "casual viewers who share fun facts with friends",
    hookStyles: ["stat_led", "contrarian_claim"],
    persona: seed("playful_explainer", "amazing animal facts"),
    verifiedFacts: [
      {
        id: "oh-1",
        tier: "established",
        text: "Octopuses have three hearts: two branchial hearts pump blood through the gills, and one systemic heart pumps it to the body.",
      },
      {
        id: "oh-2",
        tier: "established",
        text: "The systemic heart stops beating when an octopus swims, which is one reason octopuses prefer crawling to swimming.",
      },
      {
        id: "oh-3",
        tier: "established",
        text: "Octopus blood is blue because it uses copper-based hemocyanin instead of iron-based hemoglobin to carry oxygen.",
      },
      {
        id: "oh-4",
        tier: "established",
        text: "Hemocyanin carries oxygen efficiently in cold, low-oxygen water — one reason octopuses thrive in deep and polar seas.",
      },
    ],
    conjecture: [],
  },
  {
    id: "gobekli-tepe-long",
    title: "The temple older than farming",
    angle:
      "Göbekli Tepe was built by hunter-gatherers millennia before Stonehenge — and it forced archaeologists to rethink which came first: the temple or the town.",
    niche: "ancient history",
    contentFormat: "long",
    targetLengthSec: 420,
    factualityMode: "balanced",
    tone: "curious, even-handed, willing to sit with open questions",
    audiencePersona: "history viewers who like the debate as much as the answer",
    hookStyles: ["contrarian_claim", "open_loop"],
    persona: seed("contrarian_analyst", "ancient history"),
    verifiedFacts: [
      {
        id: "gt-1",
        tier: "established",
        text: "Göbekli Tepe in southeastern Türkiye dates to roughly 9500–8000 BCE, several millennia before Stonehenge or the Egyptian pyramids.",
      },
      {
        id: "gt-2",
        tier: "established",
        text: "Its circular enclosures feature carved T-shaped limestone pillars up to about 5.5 metres tall, decorated with reliefs of animals.",
      },
      {
        id: "gt-3",
        tier: "established",
        text: "The site was built by people generally considered pre-agricultural hunter-gatherers — monumental construction before settled farming was thought possible.",
      },
      {
        id: "gt-4",
        tier: "established",
        text: "Klaus Schmidt led excavations from 1995 until his death in 2014 and interpreted the site as a ritual or ceremonial centre.",
      },
      {
        id: "gt-5",
        tier: "established",
        text: "Only a fraction of the site has been excavated; ground-penetrating surveys indicate many more enclosures remain buried.",
      },
    ],
    conjecture: [
      {
        id: "gt-c1",
        tier: "contested",
        text: "Schmidt's 'temple first, city later' reading is debated — more recent work has found domestic structures and rainwater systems, suggesting people may have lived at the site rather than only gathering there.",
      },
      {
        id: "gt-c2",
        tier: "contested",
        text: "Some researchers propose that organizing the communal labour and feasting needed to build such sites helped drive the adoption of agriculture itself.",
      },
    ],
  },
];
