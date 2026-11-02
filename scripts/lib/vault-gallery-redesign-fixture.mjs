// Populated fixture for the vault browser redesign: 30 talks, 14 folders, a deep duplicate leaf,
// long titles and paths, unknown and pending facts. Every current bridge contract is mocked,
// including windows.recoverMovedTalk's no-receipt reply; guards are never stubbed away.
const folders = ['agents-2026', 'agents-presentations', 'AI Agent Workshops', 'AI Foundations - 2026 Summer School', 'ai-for-research', 'ai-for-students', 'ai-in-education', 'ambassadors', 'external-workshops', 'handout-data', 'Mapping the Landscape', 'talkweaver-demos', 'vibecoding-misc', 'z-old-powerpoint-imports']
const long = 'Context engineering for long-running agent sessions: patterns, failures and recovery across many hand-offs and tools'
const spec = [
  ['getting-started-with-talkweaver', '', 'Getting started with TalkWeaver'], ['scratch-talk', '', 'Scratch talk for trying layouts'],
  ['agent-architecture', 'agents-presentations', 'Agent architecture and context engineering'], ['collaborators', 'agents-presentations', 'Agents as collaborators: what changes when software acts on your behalf'],
  ['context-engineering', 'agents-presentations', long], ['prompts-protocols', 'agents-presentations', 'From prompts to protocols: MCP, tools and permissions'],
  ['intern-toolmaker', 'agents-presentations', 'Intern to Toolmaker: Five Roles AI Can Play'], ['mapping-risks', 'agents-presentations', 'Mapping agent risks for university IT and information-security teams'], ['what-is-an-agent', 'agents-presentations', 'What is an AI agent? A plain-language introduction for non-technical audiences'],
  ['coding-agents', 'agents-2026', 'AI as Tool User: Coding agents'], ['agents-pm', 'AI Agent Workshops', 'Agents for Project Management'], ['agents-rdm', 'AI Agent Workshops', 'Agents For Research Data Management'],
  ['agent-arch-summer', 'AI Foundations - 2026 Summer School', 'Agent Architecture and Context Engineering'],
  ['methods-a', 'external-workshops/Day 1/Morning/Group A/Room 4', 'AI for research methods'], ['methods-b', 'external-workshops/Day 1/Morning/Group B/Room 4', 'AI for research methods'],
  ['assessment', 'ai-in-education', 'Assessment after ChatGPT: redesign patterns from three university case studies'], ['learning-tech', 'ai-in-education', 'Agents as Learning Technology'], ['literacy', 'ai-in-education', 'Generative AI literacy for postgraduate supervisors'],
  ['compare', 'ai-for-students', 'Claude, ChatGPT and Gemini compared for everyday study tasks'], ['ai-for-research', 'ai-for-research', 'AI for research'],
  ['lecture-capture', 'talkweaver-demos', 'Lecture capture to handout in ten minutes'], ['demo-2', 'talkweaver-demos', 'Demo two'], ['vibe', 'vibecoding-misc', 'Vibecoding notes'],
  ['old-1', 'z-old-powerpoint-imports', 'Imported deck one'], ['old-2', 'z-old-powerpoint-imports', 'Imported deck two'], ['map-1', 'Mapping the Landscape', 'Mapping the Landscape of AI and Research'],
  ['amb-1', 'ambassadors', 'What’s New in AI — Ambassadors update'], ['amb-2', 'ambassadors', 'Ambassador onboarding'], ['stu-2', 'ai-for-students', 'Study skills with AI'], ['stu-3', 'ai-for-students', 'Writing with AI']
]
const slide = (title, i) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="${['#0f3557', '#fbf0e2', '#e9eedd', '#f4efe4'][i % 4]}"/><text x="10" y="45" font-size="9" fill="${i % 4 === 0 ? '#fff' : '#154a72'}" font-family="Georgia">${title.slice(0, 22).replace(/&/g, '&amp;')}</text></svg>`)
export const fixtureSource = `
const spec=${JSON.stringify(spec)},folders=${JSON.stringify(folders)};
const slide=${slide.toString()};
const mk=(vaultId)=>spec.map(([slug,folder,title])=>({vaultId,relativeOutline:(folder?folder+'/':'')+slug+'/'+slug+'-outline.md',title,slug}));
window.calls={catalogue:0,facts:[],inventory:[],handouts:[],listTalks:0,recover:[],claim:[],open:[],cancel:0};
const root={a:'/fixture/dominiks-presentations-library',b:'/fixture/Teaching',c:'/fixture/past',d:'/Volumes/Teaching Archive/Talks'};
window.tw={
 windows:{recoverMovedTalk:async from=>{window.calls.recover.push(from);return {kind:'no-receipt'}},claimTalk:async p=>{window.calls.claim.push(p);return {ok:true}}},
 shell:{openExternal:async()=>true},
 vault:{
  galleryCatalogue:async generation=>{window.calls.catalogue++;return {generation,rootGeneration:7,vaults:[
   {id:'a',name:'dominiks-presentations-library',status:'stale',talks:mk('a')},
   {id:'b',name:'Teaching & workshops',status:'stale',talks:mk('b').slice(0,4)},
   {id:'c',name:'Past workshops',status:'closed',talks:[]},
   {id:'d',name:'Archive drive',status:'unavailable',talks:[]}]}},
  galleryTalk:async(v,p)=>({outlinePath:root[v]+'/'+p,path:root[v]+'/'+p.split('/').slice(0,-1).join('/'),title:'t',slug:'s',vaultId:v}),
  gallerySettle:async()=>{},galleryClaim:async()=>({ok:true}),galleryCancelFacts:async()=>{window.calls.cancel++},
  galleryFacts:async(v,p,preview)=>{window.calls.facts.push([v,p,preview]);const i=spec.findIndex(s=>p.includes('/'+s[0]+'/')||p.startsWith(s[0]+'/'));if(i%7===3)return {revision:null,slideCount:null,imageCount:null,editedMs:null,coverUrl:null,preview:'unavailable'};
   return {revision:'r'+i,slideCount:20+i*7,imageCount:i%5===0?null:i*2,editedMs:Date.UTC(2026,9,1+(i%27)),coverUrl:preview?slide(spec[i][2],i):null,preview:preview?'ready':'pending'}},
  galleryHandouts:async(v,p)=>{window.calls.handouts.push(p);const i=spec.findIndex(s=>p.includes('/'+s[0]+'/')||p.startsWith(s[0]+'/'));if(i%7===3)return {status:'unknown',records:[],partial:true,note:null};
   return i%4===0?{status:'published',partial:false,note:null,records:[{key:'k',kind:'talk',title:'Handout',link:'https://example.invalid/h',site:'linked',publishedAt:null,dateSource:'record'}]}:{status:'unpublished',records:[],partial:false,note:null}},
  galleryInventory:async r=>{window.calls.inventory.push(r);const result={...r,rootIdentity:'fx',checkedAt:'2026-10-30',state:'complete',entries:window.inventoryEntries?window.inventoryEntries(r):[],counted:0,unreadable:0,excluded:0,truncated:false,logicalBytes:null,allocatedBytes:null,allocationUnknown:0};
   return r.recursive&&window.deferRecursive?new Promise(res=>{window.release=()=>res(result)}):result},
  galleryInventoryCancel:async id=>{window.calls.cancel2=(window.calls.cancel2||[]).concat(id)},onGalleryInventory:()=>()=>{},
  renameTalk:async()=>{throw Error('not in this test')},listTalks:async()=>{window.calls.listTalks++;return []}
 }};
const info=(v,p,vid)=>({title:'t',slug:'s',path:root[vid]+'/'+p.split('/').slice(0,-1).join('/'),outlinePath:root[vid]+'/'+p,vaultId:vid});
window.managementFixture=()=>({talks:[],vaults:[{id:'a',name:'dominiks-presentations-library',root:root.a,open:true},{id:'b',name:'Teaching & workshops',root:root.b,open:true},{id:'c',name:'Past workshops',root:root.c,open:false},{id:'d',name:'Archive drive',root:root.d,open:true,unavailable:true}],activeTalk:null,
 foldersByVault:{a:[...folders,'external-workshops/Day 1','external-workshops/Day 1/Morning'],b:[]},leaveActive:async()=>true,onRefresh:async()=>{window.calls.refresh=(window.calls.refresh||0)+1},onSelectTalk:async()=>true,onDeletedTalk:()=>{},onNewTalk:(...a)=>{window.calls.newTalk=a},onAddVault:()=>{window.calls.addVault=true},onEditVault:id=>{window.calls.editVault=id},onSetVaultOpen:async(id,o)=>{window.calls.setOpen=[id,o]}});
`
export const FIXTURE_TALKS = spec.length
export const FIXTURE_FOLDERS = folders
