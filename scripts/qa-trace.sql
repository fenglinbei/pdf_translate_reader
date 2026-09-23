-- QA 单次问答的完整轨迹：每一步、每轮模型决策、每次工具调用的入参与出参。
--
-- 用法（连接参数沿用 .env.qa.local 那套 PGHOST/PGUSER/PGPASSWORD）：
--   psql -p 5432 -d postgres -f scripts/qa-trace.sql
--   psql -p 5432 -d postgres -v msg_id=<uuid> -f scripts/qa-trace.sql
--
-- 不带参数时取最近一次助手回答。先看第 0 节确认取对了目标。
-- 找历史消息：select id, created_at, left(content,60) from public.user_qa_messages
--              where role='assistant' and deleted_at is null order by created_at desc limit 10;

\set msg_id ''
\pset pager off
\set ON_ERROR_STOP on

drop table if exists _trace;
create temp table _trace as
select id as message_id, thread_id, model, prompt_version, status, usage, created_at
from public.user_qa_messages
where role = 'assistant'
  and deleted_at is null
  -- id::text 而不是 ::uuid：空串转 uuid 会在计划期直接报错
  and (:'msg_id' = '' or id::text = :'msg_id')
order by created_at desc
limit 1;

\echo ''
\echo '=== 0. 目标消息（确认取对了再往下看）==='
select message_id, model, prompt_version, status, usage, created_at from _trace;

\echo ''
\echo '=== 1. 步骤时间线：每一步的类型、摘要、证据编号、原始 payload ==='
select s.step_index,
       s.kind,
       s.status,
       coalesce(s.tool_name, '-') as tool,
       s.evidence_ids,
       s.summary,
       s.payload
from public.user_qa_agent_steps s
join _trace t on t.message_id = s.message_id
where s.deleted_at is null
order by s.step_index;

\echo ''
\echo '=== 2. 模型每一轮的决定（来自 gap_check 的归一化动作）==='
\echo '    turn 对应循环的第几轮；rewritten_query 是模型自己改写的检索词'
select s.payload->>'turnIndex' as turn,
       s.payload->'action'->>'action' as model_action,
       s.payload->'action'->>'query' as rewritten_query,
       s.payload->'action'->>'topK' as top_k,
       s.payload->'action'->>'evidenceIds' as evidence_ids,
       s.payload->'action'->>'summary' as model_note
from public.user_qa_agent_steps s
join _trace t on t.message_id = s.message_id
where s.kind = 'gap_check' and s.deleted_at is null
order by s.step_index;

\echo ''
\echo '=== 3. 工具调用：完整入参、返回的证据编号、耗时 ==='
select tc.tool_name,
       tc.status,
       tc.input,
       tc.result_evidence_ids,
       tc.output_summary,
       tc.error_message,
       extract(milliseconds from (tc.finished_at - tc.started_at))::int as duration_ms
from public.user_qa_tool_calls tc
join public.user_qa_agent_steps s on s.id = tc.step_id
join _trace t on t.message_id = s.message_id
where tc.deleted_at is null
order by tc.started_at;

\echo ''
\echo '=== 4. 工具实际返回了什么（检索快照里的证据，C 编号 -> chunk）==='
select e->>'evidenceId' as evidence_id,
       e->>'chunkId' as chunk_id,
       e->>'pageStart' as page,
       round((e->>'score')::numeric, 4) as score,
       e->>'sectionPath' as section,
       left(e->>'textPreview', 90) as preview
from public.user_qa_messages m
join _trace t on t.message_id = m.id,
     jsonb_array_elements(coalesce(m.retrieval_snapshot->'evidence', '[]'::jsonb)) e
order by e->>'evidenceId';

\echo ''
\echo '=== 5. 证据对应的 chunk 正文（模型 open_chunk 后看到的全文，截前 300 字）==='
select e->>'evidenceId' as evidence_id,
       c.chunk_index,
       c.page_start,
       c.section_path,
       left(c.text, 300) as text_head
from public.user_qa_messages m
join _trace t on t.message_id = m.id,
     jsonb_array_elements(coalesce(m.retrieval_snapshot->'evidence', '[]'::jsonb)) e
join public.user_paper_chunks c on c.id = (e->>'chunkId')::uuid
where e->>'chunkId' is not null
order by e->>'evidenceId';

\echo ''
\echo '=== 6. 回答引用了哪些 chunk（引用校验的产物）==='
\echo '    引用表只存 chunk_id，这里借检索快照把 C 编号还原回来'
select coalesce(ev.eid, c.chunk_id::text) as evidence_id,
       c.page_start,
       c.confidence,
       left(c.quoted_text, 110) as quoted
from public.user_qa_citations c
join _trace t on t.message_id = c.message_id
join public.user_qa_messages m on m.id = c.message_id
left join lateral (
  select elem->>'evidenceId' as eid
  from jsonb_array_elements(coalesce(m.retrieval_snapshot->'evidence', '[]'::jsonb)) elem
  where elem->>'chunkId' = c.chunk_id::text
  limit 1
) ev on true
where c.deleted_at is null
order by c.created_at;
