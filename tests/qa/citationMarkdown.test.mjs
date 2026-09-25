import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'vite';
import {unified} from 'unified';import remarkParse from 'remark-parse';import remarkMath from 'remark-math';
let vite,plugin;
before(async()=>{vite=await createServer({configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true}});plugin=(await vite.ssrLoadModule('/src/qa/remarkCitations.ts')).remarkCitations;});
after(async()=>{await vite?.close();});
test('stream citation tokens work inside emphasis and headings while code and math remain literal',async()=>{
 const processor=unified().use(remarkParse).use(remarkMath).use(plugin,{ids:['C1','C2']});
 const tree=await processor.run(processor.parse('# Heading [C1]\n\n**Fact [C2]** and `code [C1]` $[C1]$ unknown [C9].\n\n```\n[C1]\n```'));
 const links=[];function walk(n){if(n.type==='link')links.push(n.url);for(const child of n.children??[])walk(child);}walk(tree);
 assert.deepEqual(links,['#qa-citation-C1','#qa-citation-C2']);
});
