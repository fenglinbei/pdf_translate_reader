import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const QA_PRODUCTION_MIGRATIONS = Object.freeze([
  '20260924_qa_document_tools.sql',
  '20260924_qa_conversation.sql',
  '20260925_qa_workspace.sql',
  '20260925_qa_workspace_navigation.sql',
  '20260925_qa_document_artifacts.sql',
  '20260925_qa_artifact_answers.sql',
]);

// Produce a reviewable file; this command never connects to a database or host.
// The six historical migrations have individual transactions. A first production
// cutover needs one transaction so an error cannot leave old threads upgraded
// while the new citation schema is still unavailable.
export async function buildQaProductionMigration() {
  const parts = await Promise.all(QA_PRODUCTION_MIGRATIONS.map(async name => {
    const text = await readFile(join(repository, 'supabase/migrations', name), 'utf8');
    if (!/^begin;\s*$/mi.test(text) || !/^commit;\s*$/mi.test(text)) throw new Error(`Missing transaction envelope: ${name}`);
    const body = text.replace(/^begin;\s*$/gmi, '').replace(/^commit;\s*$/gmi, '');
    return { name, sha256: createHash('sha256').update(text).digest('hex'), body };
  }));
  const sql = `-- First production QA upgrade. Review docs/qa-production-readiness.md first.
-- Requires a verified production backup and a drained QA maintenance window.
-- Generated from the six migrations already validated in the isolated QA project.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(hashtextextended('pdf-reader-qa-first-production-v1', 0));
do $$ begin
  if to_regclass('public.user_qa_document_artifacts') is not null then
    raise exception 'artifact_schema_already_present: do not replay this first-upgrade bundle';
  end if;
  if to_regclass('public.user_qa_threads') is null then
    raise exception 'qa_baseline_missing';
  end if;
end $$;

${parts.map(p => `-- Source: ${p.name}; SHA-256: ${p.sha256}\n${p.body}`).join('\n')}
commit;
`;
  return { sql, sources: parts.map(({ name, sha256 }) => ({ name, sha256 })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2] ?? 'output/qa-production');
  await mkdir(destination, { recursive: true });
  const { sql, sources } = await buildQaProductionMigration();
  const file = join(destination, 'qa-first-production.sql');
  await writeFile(file, sql);
  const manifest = { format: 'qa-first-production-migration-v1', file: 'qa-first-production.sql',
    sha256: createHash('sha256').update(sql).digest('hex'), sources, applied: false };
  await writeFile(join(destination, 'migration-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Prepared ${file}; no database changes were made.`);
}
