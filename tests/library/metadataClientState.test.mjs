import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createServer } from "vite";

describe("metadata client state",()=>{
  let vite,settings,context;
  const records=new Map();
  before(async()=>{
    globalThis.__metadataTestDb={get:async(store,key)=>records.get(`${store}:${key}`),put:async(store,value,key)=>records.set(`${store}:${key ?? value.pdfFingerprint}`,value)};
    vite=await createServer({appType:"custom",configFile:false,logLevel:"silent",server:{middlewareMode:true},plugins:[{
      name:"metadata-client-test-dependencies",enforce:"pre",
      resolveId(id){
        const mocks={"../cache":"db","../cloud/settingsCloudRepository":"settings","../cloud/documentStateRepository":"context","../cloud/syncStatus":"sync"};
        if(mocks[id])return `\0metadata-test-${mocks[id]}`;
      },
      load(id){
        if(id==="\0metadata-test-db")return 'export async function getAppDb(){return globalThis.__metadataTestDb;}';
        if(id==="\0metadata-test-settings")return 'export async function getCloudSettings(){return undefined;} export async function putCloudSettings(settings,options){return globalThis.__metadataCloudWrite(settings,options);}';
        if(id==="\0metadata-test-context")return 'export async function syncPaperContextToCloud(){} export async function deleteCloudPaperContext(){}';
        if(id==="\0metadata-test-sync")return 'export async function runCloudSync(task){return task();}';
      },
    }]});
    settings=await vite.ssrLoadModule("/src/settings/settingsRepository.ts");
    context=await vite.ssrLoadModule("/src/translation/paperContext.ts");
  });
  beforeEach(()=>{records.clear();globalThis.__metadataCloudWrite=async()=>{};});
  after(async()=>{await vite?.close();delete globalThis.__metadataTestDb;delete globalThis.__metadataCloudWrite;});
  it("defaults AI on for legacy settings and preserves an explicit opt-out",()=>{
    assert.equal(settings.normalizeAppSettings({}).libraryMetadataAiEnabled,true);
    assert.equal(settings.normalizeAppSettings({libraryMetadataAiEnabled:false}).libraryMetadataAiEnabled,false);
  });
  it("reports an opt-out failure instead of falsely storing success locally",async()=>{
    records.set("settings:app",settings.DEFAULT_APP_SETTINGS);
    globalThis.__metadataCloudWrite=async()=>{throw Error("cloud offline");};
    await assert.rejects(settings.putAppSettings({libraryMetadataAiEnabled:false}),/cloud offline/);
    assert.equal(records.get("settings:app").libraryMetadataAiEnabled,true);
  });
  it("saves a successful opt-out in the cloud before committing local state",async()=>{
    let saved;
    globalThis.__metadataCloudWrite=async (value,options)=>{assert.equal(records.get("settings:app"),undefined);assert.equal(options.writeMetadataAi,true);saved=value;return value;};
    await settings.putAppSettings({libraryMetadataAiEnabled:false});
    assert.equal(saved.libraryMetadataAiEnabled,false);
    assert.equal(records.get("settings:app").libraryMetadataAiEnabled,false);
  });
  it("preserves another device's AI opt-out when saving an unrelated setting",async()=>{
    records.set("settings:app",settings.DEFAULT_APP_SETTINGS);
    globalThis.__metadataCloudWrite=async (value,options)=>{
      assert.equal(options.writeMetadataAi,false);
      return {...value,libraryMetadataAiEnabled:false};
    };
    const result=await settings.putAppSettings({contextWindowN:3});
    assert.equal(result.libraryMetadataAiEnabled,false);
    assert.equal(records.get("settings:app").libraryMetadataAiEnabled,false);
    assert.equal(result.contextWindowN,3);
  });
  it("replaces an automatic filename context with recognized library fields",async()=>{
    records.set("paperContexts:paper",{...context.normalizePaperContext({title:"download_123",terminology:[]}),pdfFingerprint:"paper",updatedAt:1});
    const result=await context.ensurePaperContextForEntry({fingerprint:"paper",cloudDocumentId:"doc",bibliographicMetadata:{title:"Recognized Title",authors:[],abstract:"Recognized abstract"},metadataSources:{title:{source:"crossref",locked:false}}});
    assert.equal(result.title,"Recognized Title");assert.equal(result.abstract,"Recognized abstract");
  });
  it("preserves a manually edited translation context after library recognition",async()=>{
    records.set("paperContexts:paper",{...context.normalizePaperContext({title:"My translation title",terminology:[]}),pdfFingerprint:"paper",updatedAt:1,userEditedAt:1});
    const result=await context.ensurePaperContextForEntry({fingerprint:"paper",bibliographicMetadata:{title:"Recognized Title",authors:[]},metadataSources:{title:{source:"crossref",locked:false}}});
    assert.equal(result.title,"My translation title");
  });
  it("does not seed translation context from a tracked filename placeholder",async()=>{
    const result=await context.ensurePaperContextForEntry({fingerprint:"paper",pdfMetadata:{title:"download_123"},metadataSources:{title:{source:"filename",locked:false}}});
    assert.equal(result.title,undefined);
  });
});
