-- Additive budget upgrade; keep the 0.5.0 rollback compatible. No data changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create or replace function public.qa_commit_artifact_answer(p_user_id uuid,p_message_id uuid,p_content text,p_snapshot jsonb,p_usage jsonb,p_citations jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m user_qa_messages%rowtype; t user_qa_threads%rowtype; c jsonb; a user_qa_document_artifacts%rowtype; saved jsonb;
begin
 if p_content is null or p_citations is null or length(p_content)>160000 or jsonb_typeof(p_citations)<>'array' or jsonb_array_length(p_citations)>128 then raise exception 'invalid_answer_budget'; end if;
 select * into m from user_qa_messages where id=p_message_id and user_id=p_user_id and role='assistant' and deleted_at is null for update;
 if not found then raise exception 'message_not_available'; end if;
 select * into t from user_qa_threads where id=m.thread_id and user_id=p_user_id and deleted_at is null for share;
 if not found or t.scope<>'workspace' then raise exception 'thread_not_available'; end if;
 if m.status='success' then
   if m.content is distinct from p_content or m.retrieval_snapshot is distinct from p_snapshot then raise exception 'answer_already_committed'; end if;
 elsif m.status<>'streaming' then raise exception 'answer_not_streaming';
 else
   -- Lock each referenced document once. A concurrent delete serializes with
   -- this commit, and existing retained revisions remain valid after reparse.
   perform d.id from user_documents d where d.id in (select distinct (item->>'cloudDocumentId')::uuid from jsonb_array_elements(p_citations) item)
     and d.user_id=p_user_id and d.deleted_at is null order by d.id for share;
   if exists(select 1 from jsonb_array_elements(p_citations) item where not exists(select 1 from user_documents d
     where d.id=(item->>'cloudDocumentId')::uuid and d.user_id=p_user_id and d.deleted_at is null)) then raise exception 'document_not_available'; end if;
   for c in select * from jsonb_array_elements(p_citations) loop
     if c->>'sourceKind'<>'document_artifact' or c->>'confidence'<>'verified' then raise exception 'invalid_artifact_citation'; end if;
     select * into a from user_qa_document_artifacts where user_id=p_user_id and user_document_id=(c->>'cloudDocumentId')::uuid and revision=c->>'sourceVersion';
     if not found or a.manifest_sha256<>c->'sourceLocator'->>'manifestSha256' or a.pdf_sha256<>c->'sourceLocator'->>'pdfSha256'
       or c->'sourceLocator'->>'revision'<>a.revision then raise exception 'artifact_not_available'; end if;
     if coalesce((c->>'pageStart')::integer,1)>a.page_count or coalesce((c->>'pageEnd')::integer,1)>a.page_count then raise exception 'invalid_artifact_page'; end if;
     insert into user_qa_citations(user_id,message_id,user_document_id,chunk_id,pdf_fingerprint,document_title,page_start,page_end,section_path,quoted_text,line_regions,confidence,source_kind,source_version,evidence_key,source_record_id,source_locator)
     values(p_user_id,p_message_id,(c->>'cloudDocumentId')::uuid,null,coalesce(c->>'pdfFingerprint',''),c->>'documentTitle',(c->>'pageStart')::integer,(c->>'pageEnd')::integer,
       case when jsonb_typeof(c->'sectionPath')='array' then array(select jsonb_array_elements_text(c->'sectionPath')) else null end,
       left(c->>'quotedText',700),null,'verified','document_artifact',c->>'sourceVersion',c->>'evidenceKey',c->>'sourceRecordId',c->'sourceLocator');
   end loop;
   update user_qa_messages set content=p_content,status='success',error_message=null,retrieval_snapshot=p_snapshot,usage=p_usage,updated_at=now() where id=p_message_id returning * into m;
 end if;
 select coalesce(jsonb_agg(to_jsonb(q) order by substring(q.source_locator->>'evidenceId' from 2)::integer,q.id),'[]'::jsonb) into saved from user_qa_citations q where q.message_id=p_message_id and q.user_id=p_user_id and q.deleted_at is null;
 return jsonb_build_object('message',to_jsonb(m),'citations',saved);
end $$;
revoke all on function public.qa_commit_artifact_answer(uuid,uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qa_commit_artifact_answer(uuid,uuid,text,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
