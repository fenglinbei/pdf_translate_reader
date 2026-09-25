type Node = {type:string;value?:string;url?:string;children?:Node[]};
// Transform only Markdown prose text. Inline code, fenced code, math, existing
// links and images retain their meaning; nested emphasis/headings also work.
export function remarkCitations({ids}:{ids:readonly string[]}) {
 const allowed=new Set(ids);
 return (tree:Node)=>{
  const visit=(node:Node)=>{
   if(['code','inlineCode','math','inlineMath','link','image'].includes(node.type)||!node.children)return;
   node.children=node.children.flatMap(child=>{
    if(child.type!=='text'){visit(child);return [child];}
    const text=child.value??'',parts:Node[]=[];let from=0;
    for(const match of text.matchAll(/\[C([1-9][0-9]*)\]/g)){
     const ref=`C${match[1]}`;if(!allowed.has(ref))continue;const index=match.index!;
     if(index>from)parts.push({type:'text',value:text.slice(from,index)});
     parts.push({type:'link',url:`#qa-citation-${ref}`,children:[{type:'text',value:match[0]}]});from=index+match[0].length;
    }
    if(!parts.length)return [child];if(from<text.length)parts.push({type:'text',value:text.slice(from)});return parts;
   });
  };visit(tree);
 };
}
