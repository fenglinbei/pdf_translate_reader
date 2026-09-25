import { writeJson } from '../../http/json.mjs';
import { beginArtifactPreparation, cancelArtifactPreparation, getArtifactState, getPublishedArtifact, publishArtifactCandidate } from './repository.mjs';

export const artifactPreparationEnabled = () => process.env.QA_DOCUMENT_ARTIFACTS_ENABLED === 'true' || process.env.QA_AGENT_RUNTIME === 'workspace-artifacts-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function body(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 2048) throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('无效的请求。'), { statusCode: 400 }); }
}
export async function handleArtifactRoute(request, response, url, user) {
  const match = url.pathname.match(/^\/api\/qa\/documents\/([^/]+)\/artifact(?:\/(prepare|publish))?$/);
  if (!match) return false;
  try {
    if (!artifactPreparationEnabled()) { writeJson(response, 404, { error: { code: 'not_found', message: 'Route not found.' } }); return true; }
    if (!uuid.test(match[1])) throw Object.assign(new Error('无效的文档。'), { statusCode: 400 });
    const scope = { userId: user.id, documentId: match[1] };
    let result;
    if (request.method === 'GET' && !match[2]) {
      const revision = url.searchParams.get('revision');
      if (revision && !/^[a-f0-9]{64}$/.test(revision)) throw Object.assign(new Error('无效的文档版本。'), { statusCode: 400 });
      result = revision ? { state: 'ready', ...await getPublishedArtifact(scope, revision) } : await getArtifactState(scope);
    } else if (request.method === 'POST' && match[2] === 'prepare') result = await beginArtifactPreparation(scope);
    else if ((request.method === 'POST' && match[2] === 'publish') || (request.method === 'DELETE' && match[2] === 'prepare')) {
      const payload = await body(request);
      if (!uuid.test(payload?.leaseToken ?? '')) throw Object.assign(new Error('无效的准备租约。'), { statusCode: 400 });
      result = request.method === 'DELETE' ? await cancelArtifactPreparation(scope, payload.leaseToken) : await publishArtifactCandidate(scope, payload.leaseToken);
    } else { writeJson(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } }); return true; }
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, error.statusCode ?? 409, { error: { code: error.code ?? 'DOCUMENT_PREPARATION_FAILED',
      message: error.code || error.statusCode === 400 ? error.message : '文档准备暂未完成，请稍后重试。' } });
  }
  return true;
}
