-- Per-video cost & token breakdown
-- Usage: run against the prod Render Postgres. Step 1 finds the production id(s);
-- paste it into :prod for steps 2–4. A re-cut ("corrected copy") makes a NEW
-- production row that supersedes the old one, so a video may span several rows —
-- step 1b walks the supersedes chain; sum steps 2–4 across ALL ids in the chain.

-- 1) Find the production(s) for the video
select p.id, i.title, p.status, p.supersedes_production_id, p.created_at
from productions p
join ideas i on i.id = p.idea_id
where i.title ilike '%sound barrier%' or i.title ilike '%bell x-1%' or i.title ilike '%yeager%'
order by p.created_at;

-- 1b) Walk the supersedes chain from a known id (both directions)
-- with recursive chain(id) as (
--   select :prod::text
--   union
--   select p.id from productions p join chain c
--     on p.id = (select supersedes_production_id from productions where id = c.id)
--        or p.supersedes_production_id = c.id
-- ) select * from chain;

-- 2) THE TOKEN BLEED: per-agent LLM spend for this production
--    (which pipeline stage burned the tokens, at which model/tier)
select agent_name, model,
       count(*)                       as calls,
       sum(input_tokens)              as in_tok,
       sum(output_tokens)             as out_tok,
       round(sum(cost_usd), 4)        as usd,
       round(sum(duration_ms)/1000.0, 1) as secs
from agent_actions
where production_id = :prod
group by agent_name, model
order by usd desc;

-- 3) FULL cost by category — is it even tokens? (llm vs media vs voice vs render)
select category, provider, model,
       count(*)                                   as n,
       round(sum(cost_usd), 4)                    as usd,
       sum((units->>'inputTokens')::numeric)      as in_tok,
       sum((units->>'outputTokens')::numeric)     as out_tok,
       sum((units->>'images')::numeric)           as images,
       sum((units->>'renderSec')::numeric)        as render_sec,
       sum((units->>'chars')::numeric)            as tts_chars
from cost_records
where production_id = :prod
group by category, provider, model
order by usd desc;

-- 4) Grand total for the video (USD)
select round(sum(cost_usd), 4) as total_usd
from cost_records
where production_id = :prod;
