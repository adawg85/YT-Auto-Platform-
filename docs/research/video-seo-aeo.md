# Research: YouTube SEO + AEO — how AI engines pick videos, and the per-video ruleset

Deep-research run, 2026-07-07 (102 agents, 5 search angles, multi-vote
adversarial verification; a handful of late verification votes were cut short
by a session limit — affected claims sit under Unverified). Feeds BACKLOG #11
(SEO/AEO metadata engine) and #12 (info-gain niches); the RULES block below is
designed to be injected verbatim into scriptwriter/metadata prompts.

## Question

YouTube SEO and answer-engine optimization (AEO) best practices for 2025–2026,
for an automated Shorts-first channel platform whose scripts are AI-written: (1)
How do Google AI Overviews, Gemini, and AI assistants select and cite YouTube
videos — what makes a video citable/suggestable by AI? (2) Current ranking-
factor best practices for titles, descriptions, tags, hashtags, chapters,
transcripts/captions — what actually matters vs cargo cult (esp. for Shorts).
(3) Shorts-specific metadata and discovery mechanics vs long-form. (4) The
"information gain" thesis: does covering topics with no existing video coverage
(e.g. niche biographies) earn algorithmic push and source-validation from
YouTube/Google — evidence for/against. (5) Concrete, checkable rules a
scriptwriting agent should follow for every video (title patterns, description
structure, keyword placement, caption handling, what to avoid). Deliverable:
cited findings + a distilled "RULES FOR EVERY VIDEO" section usable verbatim as
an LLM prompt block.

## Executive summary

YouTube is a top-2 cited domain across AI answer engines, but AI citations go
overwhelmingly (94%) to long-form video, not Shorts (5.7%) — so a Shorts-first
channel wins feed discovery, not AEO citability, unless it adds structured long-
form. What earns AI citation is machine-extractable structure (long metadata-
style descriptions r=0.31, chapters/timestamps that act as headers), not
popularity (subscriber count r=-0.03; 40.83% of cited videos had <1,000 views).
Within YouTube itself, Search ranking matches title/description/tags AND spoken
content against the query and then weighs per-query watch behavior and channel-
level E-A-T, while the Shorts feed ignores metadata optimization and ranks on
chose-to-view, retention percentage, enjoyment signals, and recency. The
"information gain" thesis is unsupported as stated: Google's patent scores
follow-up-need documents in assistant dialogs, not a general uniqueness bonus,
though the low-popularity-citation data indirectly favors covering uncovered
topics for AEO. Tags are officially near-irrelevant; title, thumbnail, and
description are the metadata that matter.

## RULES FOR EVERY VIDEO (prompt block — inject verbatim)

```
RULES FOR EVERY VIDEO (LLM prompt block — use verbatim):
1. TITLE: State the primary search phrase in natural word order, accurately describing the content. Never clickbait-mismatch — search rank depends on whether searchers of that exact query actually watch (per-query watch time).
2. SPOKEN SCRIPT IS METADATA: Say the primary keyword, the subject's full name, and key entities aloud in the first 5 seconds. The transcript is a relevance-matching surface alongside title/description.
3. HOOK + COMPLETION: First 1–2 seconds must earn the choose-to-watch decision. Script for percentage-watched, not length: a 30s Short watched 90% beats a 2min Short watched 30%. Target 80–90% completion; cut anything that risks a swipe. No padding, no slow intros, no outro fluff.
4. DESCRIPTION: Write a substantive, metadata-style description, not one line. Sentence 1 restates the topic with the primary keyword. Then a declarative factual summary (who/what/when key facts). Longer structured descriptions are the strongest correlate of repeat AI citation (r=0.31).
5. CHAPTERS: For any video with distinct sections (all long-form; Shorts where feasible), add 2–5 timestamps with keyword-bearing, header-like labels. Timestamped segments are what AI engines cite.
6. TAGS: Spend near-zero effort. Only add misspellings/aliases of the subject name. Tags play a minimal role in discovery (official). Never keyword-stuff.
7. CAPTIONS: Ensure accurate captions; write scripts so names, dates, and numbers are spoken clearly and unambiguously for ASR.
8. EXTRACTABILITY: State facts as standalone declarative sentences an AI can quote (e.g. "X was born in 1902 in Y"), not vague teases ("you won't believe when he was born").
9. NICHE CONSISTENCY: Every video stays on the channel's single topic — search quality is scored via channel-level expertise/authoritativeness/trustworthiness on a given topic.
10. RECENCY: Shorts feed exposure favors fresh uploads and decays after ~30 days — publish consistently; don't rely on Shorts back-catalog.
11. DO NOT expect titles/tags to win Shorts feed distribution — the feed ranks on performance + personalization only; metadata wins the Search surface. Optimize both independently.
12. AVOID: keyword stuffing, hashtag spam (hashtags optional), engagement bait, misleading hooks, tag-focused effort, and padding runtime for "watch time."
```

## Verified findings

### 1. [HIGH] YouTube is one of the top citable surfaces for AI answer engines: in Peec AI's 30M-source analysis i…

YouTube is one of the top citable surfaces for AI answer engines: in Peec AI's
30M-source analysis it is the #2 most-cited domain in AI-generated answers
(behind Reddit, ahead of LinkedIn), and it ranks top-tier in every parallel
study (Goodie, Semrush, Profound).

**Evidence:** "Reddit ranks as the most-cited domain in AI-generated answers,
followed by YouTube and LinkedIn, based on a new analysis of 30 million sources
by Peec AI." Corroborated across multiple independent studies; exact ordering
varies by platform but YouTube's top-tier position is robust.

Verification votes: 3-0

- https://searchengineland.com/ai-search-engines-cite-reddit-youtube-and-linkedin-most-study-473138
- https://peec.ai/blog

### 2. [MEDIUM] AI platforms overwhelmingly cite long-form YouTube video over Shorts: 94% of observed AI citations w…

AI platforms overwhelmingly cite long-form YouTube video over Shorts: 94% of
observed AI citations went to long-form, only 5.7% to Shorts (largest cited
cluster: 10–20 min videos, 32.1%). This directly challenges a Shorts-first
strategy for AEO/citability, though not for feed discovery.

**Evidence:** OtterlyAI YouTube Citation Study 2026 (100M+ citation instances
across ChatGPT, AI Overviews, AI Mode, Perplexity, Copilot, Gemini): "Long-form
video accounts for 94% of AI citations. Shorts account for 5.7%." Single vendor
dataset, not peer-reviewed, base rates uncontrolled — but no contradicting
source found.

Verification votes: 3-0

- https://otterly.ai/blog/youtube-ai-citation-study-2026/

### 3. [MEDIUM] What makes a video AI-citable is machine-extractable structure, not popularity: subscriber count sho…

What makes a video AI-citable is machine-extractable structure, not popularity:
subscriber count showed near-zero correlation with citation (r = -0.03); 40.83%
of cited videos had <1,000 views, 36% had <15 likes, 35% of cited channels had
<10k subscribers. Description length was the strongest correlate of repeat
citation (r = 0.31), and 78% of timestamped cited videos were cited multiple
times across 2–5 chapters. Small/new automated channels can be cited if content
is built for extraction: timestamps that function like headers, descriptions
that read like metadata.

**Evidence:** "Channel subscriber count showed a near-zero Pearson correlation
with citation frequency (r = −0.03)... Description length at r = 0.31 is the
strongest correlate with repeat citation frequency... What matters is structure:
timestamps that function like headers, descriptions that read like metadata, and
content built for extraction." Vendor study, correlational (r=0.31 explains
repeat citation among already-cited videos, not initial eligibility); figures
corroborated by GlobeNewswire, VEED, WebFX coverage.

Verification votes: [1] 2-1, [2] 3-0 (merged)

- https://otterly.ai/blog/youtube-ai-citation-study-2026/

### 4. [HIGH] YouTube Search relevance is matched against title, tags, description AND the video content itself (t…

YouTube Search relevance is matched against title, tags, description AND the
video content itself (transcript/ASR) — so keyword placement in both written
metadata and the spoken script matters. Engagement is measured per-query: a
video's rank for a query depends on whether searchers of that specific query
watch it, not overall watch time. This applies to Shorts on the search surface
too: ranking depends on how well metadata matches the query plus click-and-watch
behavior.

**Evidence:** Official YouTube docs: "how well the title, tags, description, and
video content match a viewer's search query"; "the watch time of a particular
video for a particular query"; Shorts search: "how well the metadata matches the
viewers' search and whether or not the viewers click and watch the content."
Transcript-as-ranking-surface corroborated by the Discovery Digital Networks
closed-caption ranking experiment.

Verification votes: 3-0, 3-0, 3-0 (merged: claims 3, 4, 8)

- https://support.google.com/youtube/answer/16090438?hl=en
- https://support.google.com/youtube/answer/11914225?hl=en&co=YOUTUBE._YTVideoType%3Dshorts

### 5. [HIGH] Search quality is assessed at the CHANNEL level via expertise/authoritativeness/trustworthiness (E-A…

Search quality is assessed at the CHANNEL level via
expertise/authoritativeness/trustworthiness (E-A-T) on a given topic — topical
consistency of the channel affects how individual videos rank in search,
supporting a single-niche channel strategy. Caveat: this governs Search quality
signals; YouTube's recommendations lead says the feed evaluates videos more
individually.

**Evidence:** "YouTube's system is designed to identify signals that can help
determine which channels demonstrate expertise, authoritativeness and
trustworthiness on a given topic." Official primary documentation; scoped to
search, with E-A-T weighting strongest for news/YMYL topics.

Verification votes: 3-0

- https://support.google.com/youtube/answer/16090438?hl=en

### 6. [HIGH] Tags are cargo cult: YouTube officially states tags play a minimal role in discovery (main legitimat…

Tags are cargo cult: YouTube officially states tags play a minimal role in
discovery (main legitimate use: commonly misspelled terms) and that title,
thumbnail, and description are the more important discovery metadata. A
scriptwriting agent should prioritize title and description; heavy tag
optimization is wasted effort for both Shorts and long-form.

**Evidence:** "Tags can be useful if the content of your video is commonly
misspelled. Otherwise, tags play a minimal role in your video's discovery...
Your video's title, thumbnail, and description are more important pieces of
metadata." Verbatim official documentation; even keyword-tool vendors (Ahrefs,
vidIQ) concur tags are a very low-weight signal.

Verification votes: 3-0, 3-0 (merged: claims 10, 11)

- https://support.google.com/youtube/answer/146402?hl=en

### 7. [HIGH] Shorts feed ranking is driven by performance and viewer personalization, NOT metadata optimization. …

Shorts feed ranking is driven by performance and viewer personalization, NOT
metadata optimization. The stated signal sequence: (1) does the viewer choose to
watch when shown vs ignore/'not interested', (2) average view duration and
average percentage viewed, (3) enjoyment via likes/dislikes and post-watch
surveys. A scriptwriting agent should therefore optimize the hook and full-watch
retention — titles/tags alone cannot materially win feed distribution.

**Evidence:** "Shorts are ranked based on performance and viewer
personalization... Systems use signals for percentage of viewers who chose to
view, average view duration and average percentage viewed to inform ranking, and
finally look at whether viewers enjoyed the Short using likes/dislikes and post-
watch survey results." Official docs; productized as the 'Viewed vs. swiped
away' analytics metric.

Verification votes: 3-0, 3-0 (merged: claims 6, 7)

- https://support.google.com/youtube/answer/11914225?hl=en&co=YOUTUBE._YTVideoType%3Dshorts

### 8. [MEDIUM] For Shorts, percentage-watched outweighs total watch time: YouTube's own guidance says relative watc…

For Shorts, percentage-watched outweighs total watch time: YouTube's own
guidance says relative watch time matters more for short videos and absolute
watch time for long ones. Third-party benchmarks: top performers hit 70–90%
average completion; consistently below ~50% marks content as skippable; a 20s
Short watched 90% outperforms a 2-min Short watched 30%. Treat the percentages
as heuristics, not published algorithm thresholds.

**Evidence:** "The algorithm cares more about percentage watched than total
watch time. A 20-second Short where people watch 90%... will outperform a
2-minute Short where people only watch 30%." Core mechanism corroborated by
YouTube Creator Insider guidance and Paddy Galloway's data (70–90% viewed rate
for top Shorts); numeric cutoffs are vendor heuristics.

Verification votes: 2-1

- https://www.shortimize.com/blog/how-does-youtube-shorts-algorithm-work
- https://vidiq.com/blog/post/youtube-shorts-algorithm/

### 9. [HIGH] The Shorts feed weights content recency more heavily than other surfaces — fresh uploads get prefere…

The Shorts feed weights content recency more heavily than other surfaces — fresh
uploads get preferential exposure and Shorts impressions decay sharply after
~28–30 days. For a Shorts-first channel this means consistent publishing cadence
matters more than evergreen back-catalog on the feed surface.

**Evidence:** Official doc: "The Shorts feed, with its snackable and trendy
nature, may tune up on the recency of content, making it great for the discovery
of new content." Independently corroborated by retention analyst Mario Joos's
cross-channel data (Tubefilter, Dec 2025) showing Shorts impressions flatten
after the 28–30 day mark while long-form resurfaces.

Verification votes: 3-0

- https://support.google.com/youtube/answer/16559651?hl=en
- https://www.tubefilter.com

### 10. [HIGH] For Google Search/AI Overviews video indexing, text surrounding the video is an official lever: Goog…

For Google Search/AI Overviews video indexing, text surrounding the video is an
official lever: Google states information about videos comes from on-page text
(page title, headings, description, captions near the video) and that each watch
page needs a unique title and description. Unique descriptive per-video text is
officially documented practice, not cargo cult.

**Evidence:** "Make sure each watch page has a page title and description that
are unique to that video. Some information about videos comes from text on the
page, such as the page title, headings, and captions near the video." Google
Search Central primary documentation, live and current.

Verification votes: 3-0

- https://developers.google.com/search/docs/appearance/video

### 11. [MEDIUM] The 'information gain' thesis is NOT supported as a general uniqueness ranking bonus: Google's 'Cont…

The 'information gain' thesis is NOT supported as a general uniqueness ranking
bonus: Google's 'Contextual Estimation of Link Information Gain' patent (filed
2018, granted June 2024) is framed around automated assistants/chatbots and
scores a SECOND set of documents that anticipate a user's follow-up need after a
first set was already seen — it is dialog-context re-ranking, not an initial-
ranking novelty bonus, and there is no evidence it functions as a YouTube
'algorithmic push' for uncovered topics. Indirect support for covering no-
coverage niches comes instead from the AI-citation data (obscure low-view videos
get cited when they are the only structured source), i.e. the payoff is AEO
citability, not confirmed YouTube recommendation push.

**Evidence:** SEJ: "The patent is largely in the context of automated assistants
and chatbots... assigning an Information Gain score to rank a second set of web
pages that are relevant for predicting the next related information need."
Patent text confirms the first-set/second-set structure ('automated assistant'
appears 69 times vs 'search engine' 25). Marketing claims of information gain as
a confirmed organic ranking factor have no Google confirmation.

Verification votes: [14] 2-1, [15] 3-0 (merged)

- https://www.searchenginejournal.com/googles-information-gain-patent-for-ranking-web-pages/524464/
- https://patents.google.com/patent/US12013887B2

## Caveats

Four claims could not be verified due to infrastructure errors (all 3 verifier
votes errored) and are neither confirmed nor refuted: (1) YouTube search
combining keyword relevance with per-query engagement history (per
answer/16559651); (2) recommendations 'pull' videos per viewer rather than
'push' them out — which would directly undercut any naive 'information gain
earns push' reading; (3) the recommender optimizing surveyed 'valued watch time'
rather than raw watch time; (4) per-video/per-topic performance evaluation with
Shorts and long-form scored independently. Treat these as plausible but uncited.
The AI-citation statistics (94% long-form, r=0.31 description length, r=-0.03
subscribers) all come from a single vendor study (OtterlyAI, ~March 2026) that
is not peer-reviewed, has no base-rate controls, and whose canonical URL slug
differs from the one originally cited (/blog/youtube-ai-citation-study-2026/
resolves; the cited variant 403s); attribute figures to OtterlyAI rather than
treating them as ground truth. Peec AI's domain ranking is drawn from customer-
tracked, brand-skewed prompts and orderings vary by platform. Completion-rate
thresholds (80–90% / sub-50%) are analytics-vendor heuristics, not published
YouTube cutoffs. Time-sensitivity is high: AI citation patterns are volatile
(ChatGPT sharply cut Reddit/Wikipedia citations in Sept 2025), and the Shorts
recency decay behavior was first observed mid-Sept 2025 — all findings reflect
the 2025–mid-2026 window. Four related claims were refuted in verification and
excluded, notably the specific 'seed audience of a few hundred viewers' explore-
exploit mechanic and a fixed 75–80% view-rate distribution trigger. Direct
fetches of support.google.com and otterly.ai were proxy-blocked (403), so
several verbatim quotes were confirmed via exact-phrase search and multiple
independent secondary citations rather than raw page fetches.

## Open questions

- Should a Shorts-first platform add companion long-form (or 10–20 min
compilations of Shorts scripts) specifically to capture AI citations, given 94%
of AI citations go to long-form and the largest cited cluster is 10–20 min
videos?
- Do AI engines extract Shorts descriptions/captions at all, and do timestamped
citations (observed only on Google AI surfaces) work for Shorts — i.e., is any
AEO structuring of a Short worthwhile, or is the 5.7% ceiling structural?
- Does covering topics with zero existing video coverage earn any measurable
YouTube-side recommendation advantage (as opposed to AEO citability), given the
'push vs pull' and per-video evaluation claims went unverified?
- How do channel-level E-A-T quality signals treat brand-new, fully automated
channels with AI-written scripts — is there a disclosure-related or synthetic-
content dampener on the Search quality score, and how fast does topical
authority accrue?

## Refuted claims (checked and rejected)

- YouTube search ranks videos primarily by three factor categories — relevance,
engagement, and quality — plus personalization from the viewer's search and
watch history; there is no separate 'freshness' or 'upload recency' factor named
in the official documentation.
- YouTube ranks in the top five cited domains across all five major AI answer
engines measured (ChatGPT, Google AI Mode, Gemini, Perplexity, and Google AI
Overviews), meaning a YouTube video can be directly cited by every major AI
assistant, not just Google properties.
- YouTube Shorts distribution follows an explore-exploit pattern: each new Short
is first seeded to a small test audience of roughly a few hundred to a few
thousand viewers, and early retention/engagement on that seed determines whether
it gets expanded to wider distribution.
- The 'viewed vs. swiped away' ratio is a primary Shorts feed metric, with a
benchmark of ~75-80% view rate for top creators; hitting that level is what
triggers broader distribution.

## Unverified (verification incomplete — treat as unconfirmed)

- YouTube search ranking combines keyword relevance with per-query engagement
history: results are surfaced according to keyword queries AND which videos have
historically driven the most engagement for that specific query.
- YouTube's recommendation system does not 'push' videos out to audiences; it
pulls videos per individual viewer based on their watch behavior — meaning there
is no generic 'algorithmic push' a video can earn independent of viewer-side
demand (direct evidence against a naive 'information gain earns push' reading
for YouTube recommendations).
- The recommender optimizes for surveyed viewer satisfaction ('valued watch
time'), not raw watch behavior alone — YouTube runs in-product surveys and uses
responses to influence how a video and similar content get distributed; raw
watch time is explicitly not the target metric.
- Performance is evaluated at the level of each individual video and topic, not
at the channel/creator level — an underperforming Short does not reduce the
distribution of the channel's next long-form video (Shorts and long-form are
effectively scored independently).

## All sources

- https://otterly.ai/blog/the-youtube-citation-study-2026/
- https://www.brightedge.com/blog/youtubes-growing-impact-google-ai-overviews-what-marketers-need-know
- https://searchengineland.com/ai-search-engines-cite-reddit-youtube-and-linkedin-most-study-473138
- https://www.conbersa.ai/learn/youtube-aeo-getting-cited-from-video
- https://www.mediapost.com/publications/article/400334/youtube-citations-in-google-ai-overviews-surge.html
- https://www.leapd.ai/blog/ai-visibility/how-chatgpt-google-ai-overviews-and-perplexity-source-information-in-2026
- https://support.google.com/youtube/answer/16090438?hl=en
- https://support.google.com/youtube/answer/11914225?hl=en&co=YOUTUBE._YTVideoType%3Dshorts
- https://developers.google.com/search/docs/appearance/video
- https://support.google.com/youtube/answer/12948449?hl=en
- https://support.google.com/youtube/answer/146402?hl=en
- https://support.google.com/youtube/answer/16559651?hl=en
- https://www.youtube.com/watch?v=dhYIb72L1hU
- https://vidiq.com/blog/post/youtube-shorts-algorithm/
- https://www.shortimize.com/blog/how-does-youtube-shorts-algorithm-work
- https://backlinko.com/youtube-ranking-factors
- https://www.searchenginejournal.com/googles-information-gain-patent-for-ranking-web-pages/524464/
- https://adoutreach.beehiiv.com/p/how-youtube-s-algorithm-really-works-in-2025-straight-from-youtube-s-director-of-growth
- https://vidiq.com/blog/post/youtube-seo/
- https://www.socialmediatoday.com/news/youtube-clarifies-monetization-update-inauthentic-repeated-content/752892/
