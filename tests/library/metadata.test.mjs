import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEmbeddedMetadata, parseMetadataAuthors } from "../../shared/pdfMetadata.mjs";
import { headerIdentifiers, matchesPaper, mergeMetadata, recognizeMetadata, validateAiMetadata } from "../../server/library/metadata.mjs";
import { parseArxivMetadata, parseCrossrefMetadata } from "../../server/library/providers.mjs";
import { normalizeMetadataRequest } from "../../server/routes/library.mjs";
import { extractPdfHeader } from "../../server/library/pdfHeader.mjs";

const title = "A Reliable Synthetic Paper Title";
const header = { title, authors: ["Alice Example", "Bob Example"], pages: [`${title}\nAlice Example; Bob Example\n2024\nAbstract\nThis synthetic abstract explains the experiment.\n1 Introduction\nBody text.`] };
const document = { title: "download_123", authors: [], display_file_name: "download_123.pdf", metadata_sources: {title:{source:"filename",locked:false}}, metadata_state:{jobId:"job"} };
const candidate = (value, source = "crossref") => ({ value, source });

describe("bibliographic recognition", () => {
  it("preserves XMP author arrays and order, falling back from an empty array", () => {
    assert.deepEqual(readEmbeddedMetadata({}, new Map([["dc:creator",["Doe, Jane","张三"]]])), {title:undefined, authors:["Doe, Jane","张三"]});
    assert.deepEqual(readEmbeddedMetadata({Author:"Alice; Bob"}, new Map([["dc:creator",[]]])).authors, ["Alice","Bob"]);
    assert.equal(readEmbeddedMetadata({Title:"Microsoft Word - draft.docx"}).title, undefined);
  });
  it("does not split inverted author names on commas", () => {
    assert.deepEqual(readEmbeddedMetadata({Author:"Doe, Jane; 王小明"}).authors,["Doe, Jane","王小明"]);
    assert.deepEqual(parseMetadataAuthors("Doe, Jane\nWang Wei\nWang Wei"),["Doe, Jane","Wang Wei","Wang Wei"]);
  });
  it("detects own header IDs and excludes references and ambiguous DOI lists", () => {
    assert.equal(headerIdentifiers({pages:["Title\ndoi:10.1234/own\nAbstract text\nReferences\n10.9999/other"]}).doi,"10.1234/own");
    assert.equal(headerIdentifiers({pages:["10.1234/one 10.1234/two"]}).doi,undefined);
    assert.equal(headerIdentifiers({pages:["References\n10.1234/other"]}).doi,undefined);
    assert.equal(headerIdentifiers({pages:[]},"2401.12345v2.pdf").arxivId,"2401.12345v2");
  });
  it("requires a title match before accepting identifier lookup metadata", () => {
    assert.equal(matchesPaper({title},header),true);
    assert.equal(matchesPaper({title:"Another Unrelated Paper Title"},header),false);
  });
  it("rejects AI fields without an exact quote or with an invented value", () => {
    const extracted=validateAiMetadata(JSON.stringify({
      title:{value:title,evidence:title}, authors:{value:["Alice Example","Imaginary Author"],evidence:"Alice Example; Bob Example"},
      publication_year:{value:2024,evidence:"2024"}, doi:{value:"10.1234/invented",evidence:"missing"},
    }),header.pages.join("\n"));
    assert.deepEqual(Object.keys(extracted),["title","publication_year"]);
  });
  it("fills empty fields and replaces tracked filename placeholders", () => {
    const merged=mergeMetadata(document,{candidates:{title:candidate(title),authors:candidate(header.authors)}});
    assert.deepEqual(merged.patch,{title,authors:header.authors});
    assert.equal(merged.state.status,"completed");
    assert.equal(merged.sources.title.source,"crossref");
  });
  it("preserves legacy, manually edited, and manually cleared fields as suggestions", () => {
    for(const doc of [
      {...document,title:"Legacy title",metadata_sources:{}},
      {...document,title:"My title",metadata_sources:{title:{source:"user",locked:true}}},
      {...document,title:null,metadata_sources:{title:{source:"user",locked:true}}},
    ]) {
      const merged=mergeMetadata(doc,{candidates:{title:candidate(title)}});
      assert.equal(merged.patch.title,undefined);
      assert.equal(merged.state.suggestions.title.value,title);
      assert.equal(merged.state.status,"needs_review");
    }
  });
  it("keeps low-confidence layout guesses for review", () => {
    const merged=mergeMetadata(document,{candidates:{title:{...candidate(title,"pdf_text"),review:true}}});
    assert.equal(merged.patch.title,undefined);
    assert.equal(merged.state.status,"needs_review");
  });
  it("does not call AI when it is disabled, while keeping local extraction", async () => {
    let calls=0;
    const result=await recognizeMetadata({document,header,aiAllowed:async()=>false,ai:async()=>{calls++;},lookupDoi:async()=>null,lookupArxiv:async()=>null});
    assert.equal(calls,0); assert.equal(result.candidates.title.value,title);
    assert.equal(result.candidates.abstract.value,"This synthetic abstract explains the experiment.");
  });
  it("uses one bounded AI fallback for missing core fields", async () => {
    let calls=0;
    const result=await recognizeMetadata({document,header,aiAllowed:async()=>true,ai:async()=>{calls++;return {content:JSON.stringify({publication_year:{value:2024,evidence:"2024"}})};},lookupDoi:async()=>null,lookupArxiv:async()=>null});
    assert.equal(calls,1); assert.equal(result.candidates.publication_year.value,2024);
  });
  it("rejects a mismatched lookup and retains extracted PDF values", async () => {
    const result=await recognizeMetadata({document,header:{...header,pages:[`${title}\n10.1234/test\nAbstract text`]},aiAllowed:async()=>false,lookupDoi:async()=>({title:"Unrelated paper",authors:["Other"]}),lookupArxiv:async()=>null});
    assert.equal(result.candidates.title.value,title);
    assert.deepEqual(result.warnings,["identifier_mismatch"]);
  });
  it("does not invoke AI for scanned pages or when core metadata is complete", async () => {
    let calls=0;
    const base={document,aiAllowed:async()=>{calls++;return true;},ai:async()=>{throw Error();},lookupDoi:async()=>null,lookupArxiv:async()=>null};
    assert.equal((await recognizeMetadata({...base,header:{pages:[""],authors:[]}})).needsOcr,true);
    await recognizeMetadata({...base,document:{...document,publication_year:2024},header});
    assert.equal(calls,0);
  });
  it("does not use the Crossref deposit date as publication year", () => {
    const parsed=parseCrossrefMetadata({message:{DOI:"10.1234/test",title:[title],created:{"date-parts":[[2025]]},author:[{given:"Alice",family:"Example"}]}},"10.1234/test");
    assert.equal(parsed.publication_year,undefined);
    assert.deepEqual(parsed.authors,["Alice Example"]);
  });
  it("parses arXiv authors, entities and preprint year and checks version identity", () => {
    const xml=`<feed><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>A &amp; B</title><author><name>Doe, Jane</name></author><author><name>王小明</name></author><published>2024-01-02</published><updated>2025-02-03</updated><summary><![CDATA[A < B]]></summary></entry></feed>`;
    assert.deepEqual(parseArxivMetadata(xml,"2401.12345").authors,["Doe, Jane","王小明"]);
    assert.equal(parseArxivMetadata(xml,"2401.12345").publication_year,2024);
    assert.equal(parseArxivMetadata(xml,"2401.12345").title,"A & B");
    assert.equal(parseArxivMetadata(xml,"2401.12345v1"),null);
    assert.throws(()=>parseArxivMetadata('<!DOCTYPE feed>'+xml,"2401.12345"));
  });
  it("bounds and validates batch requests", () => {
    const id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    assert.deepEqual(normalizeMetadataRequest({documentIds:[id,id]}),[id]);
    for (const ids of [[],["other-user"],Array(101).fill(id)]) assert.throws(()=>normalizeMetadataRequest({documentIds:ids}));
  });
});

// Real PDF.js parsing, including XMP arrays and a first-page text layer.
export function syntheticPdf() {
  const xmp=`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic PDF Metadata</dc:title><dc:creator><rdf:Seq><rdf:li>Alice Example</rdf:li><rdf:li>Bob Example</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const content="BT /F1 20 Tf 50 750 Td (Synthetic PDF Metadata) Tj 0 -30 Td /F1 12 Tf (Alice Example; Bob Example) Tj 0 -30 Td (Abstract A useful synthetic abstract for metadata extraction.) Tj ET";
  const objects=["<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`];
  let pdf="%PDF-1.4\n"; const offsets=[0];
  objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${body}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf); pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1)) pdf+=`${String(offset).padStart(10,"0")} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

it("extracts title, individual authors and page text from an actual PDF", async()=>{
  const parsed=await extractPdfHeader(syntheticPdf(),AbortSignal.timeout(5000));
  assert.equal(parsed.title,"Synthetic PDF Metadata");
  assert.deepEqual(parsed.authors,["Alice Example","Bob Example"]);
  assert.match(parsed.pages[0],/Abstract A useful/);
});
