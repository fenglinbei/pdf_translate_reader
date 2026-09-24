import { pathToFileURL } from 'node:url';
import { checkQaDocumentSchema } from '../server/qa/documents/schema.mjs';
export { checkQaDocumentSchema };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkQaDocumentSchema();
  console.log('QA document citation fields are readable. Full migration, including policies and constraints, must also be applied.');
}
