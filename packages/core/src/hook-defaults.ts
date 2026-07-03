/**
 * Default hook archetype templates (spec §5.5) so the library works before
 * any ingestion has run. Ingested templates from high-retention videos land
 * alongside these in hook_templates.
 */
export const DEFAULT_HOOK_TEMPLATES = [
  {
    id: "01HOOKDEFAULT0CURIOSITYGAP",
    name: "Curiosity gap",
    archetype: "curiosity_gap" as const,
    skeleton: {
      first2s: "Pose a question the viewer realises they can't answer",
      beatPlan: [
        "hook: open the loop with the unanswered question",
        "stat: one concrete number that makes the gap feel real",
        "insight: the mechanism that closes the gap",
        "insight: where else the viewer will now notice it",
        "cta: promise the next gap",
      ],
      payoffPlacement: "answer lands at ~70% of runtime, never earlier",
      loopOrCta: "closing line points at a sibling question to keep the loop open",
    },
  },
  {
    id: "01HOOKDEFAULT0PATTERNINTRP",
    name: "Pattern interrupt",
    archetype: "pattern_interrupt" as const,
    skeleton: {
      first2s: "State something visually/verbally jarring that breaks scroll autopilot",
      beatPlan: [
        "hook: the interrupt itself, no preamble",
        "insight: why the weird thing is actually true",
        "stat: evidence that it's not a trick",
        "insight: reframe the viewer's mental model",
        "cta: dare the viewer to test it themselves",
      ],
      payoffPlacement: "partial payoff immediately, full payoff at ~60%",
      loopOrCta: "challenge-style CTA",
    },
  },
  {
    id: "01HOOKDEFAULT0STAKESFIRST0",
    name: "Stakes first",
    archetype: "stakes_first" as const,
    skeleton: {
      first2s: "Lead with what it costs the viewer to not know this",
      beatPlan: [
        "hook: the stakes, framed personally",
        "stat: how many people get it wrong",
        "insight: the correct model",
        "insight: how to apply it in one step",
        "cta: retention promise",
      ],
      payoffPlacement: "solution starts at ~50%, applied by ~85%",
      loopOrCta: "benefit-forward CTA",
    },
  },
  {
    id: "01HOOKDEFAULT0CONTRARIAN00",
    name: "Contrarian claim",
    archetype: "contrarian" as const,
    skeleton: {
      first2s: "Assert the opposite of what everyone believes",
      beatPlan: [
        "hook: the contrarian claim, stated flatly",
        "insight: steelman the common belief first",
        "stat: the evidence that flips it",
        "insight: the better model",
        "cta: invite disagreement in comments",
      ],
      payoffPlacement: "flip lands at ~55%",
      loopOrCta: "debate-bait CTA (civil)",
    },
  },
];
