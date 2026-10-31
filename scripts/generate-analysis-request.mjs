import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analysisImplementation} from '../src/loop-analysis.js';
import {nativeBinding} from '../src/loop-native-adapter.js';
import {normalizeLoopRequest,fileArtifact,digest,loopStages} from '../src/loop-controller.js';
import {requireThat,configAt} from '../src/common.js';
export function generateAnalysisRequest(spec) {
  requireThat(spec && spec.authorizationRef && spec.stateOwner?.accessApproved===true,'Explicit existing authorization reference and approved state owner required');
  requireThat(isAbsolute(spec.bundlePath??''),'Absolute existing bundlePath required');
  const bundle=JSON.parse(readFileSync(spec.bundlePath,'utf8'));
  requireThat(bundle.format==='loop-native-settings-v1' && bundle.executeProposer===false, 'Use an existing native bundle with executeProposer:false; publication is not authorized');
  requireThat(!bundle.collectionReuse,'This native producer example requires its own run; collectionReuse requires separately qualified producer binding');
  const collector=configAt(bundle.collectorConfig),proposer=configAt(bundle.proposerConfig);
  requireThat(collector.schedule.enabled===false && proposer.schedule.enabled===false,'Inner schedules must already be disabled');
  requireThat(bundle.collection?.dryRun===true && collector.dryRun.collectionOnly,'Existing collection-only namespace required');
  requireThat(Date.parse(spec.deadlineAt)>Date.now() && Date.parse(bundle.collection.authorization?.deadlineAt)>=Date.parse(spec.deadlineAt),'Current bounded request and collection authorization deadlines required');
  const configuration=[spec.bundlePath,bundle.collectorConfig,bundle.proposerConfig].map(fileArtifact);
  const input={format:'evidence-loop-v1',origin:'manual',workflowId:spec.workflowId,occurrence:spec.occurrence,timeZone:spec.timeZone,
    ...(spec.window?{window:spec.window}:{}),stateOwner:spec.stateOwner,configuration,deadlineAt:spec.deadlineAt,rsiMode:'capture-only',
    sourcePolicySha256:digest({identity:collector.identity,sources:collector.sources,passes:bundle.collection.passes}),
    executionPolicySha256:digest({collector:configuration[1],proposer:configuration[2],executeProposer:false,rsiMode:'capture-only'}),
    adapters:Object.fromEntries(loopStages.map(s=>[s,nativeBinding()])),budgets:spec.budgets,
    analysis:{mode:'analysis-only-v1',host:'agent-maestro',endpoint:'http://127.0.0.1:23333/api/openai/v1/responses',model:'gpt-6-astra',
      timeoutMs:spec.analysisTimeoutMs??75000,maxCalls:1,maxInputBytes:spec.maxInputBytes??2000000,producerRelease:spec.producerRelease,implementation:analysisImplementation(),
      sources:[{stage:'collect',index:0,profile:'receipt-summary'},{stage:'filter',index:4,profile:'filter-result'},
        {stage:'proposer',index:0,profile:'proposer-result'},{stage:'rsi',index:0,profile:'app-observation'}]}};
  normalizeLoopRequest(input);
  return input;
}
export function generateMain(argv=process.argv.slice(2)) {
  const get=key=>{const i=argv.indexOf(key);requireThat(i>=0 && argv[i+1] && !argv[i+1].startsWith('--'),'Required '+key);return argv[i+1];};
  const spec=JSON.parse(readFileSync(get('--spec'),'utf8')),request=generateAnalysisRequest(spec);
  if(!argv.includes('--check'))writeFileSync(get('--out'),JSON.stringify(request,null,2)+'\n',{flag:'wx',mode:0o600});
  return {state:'inactive',validation:'offline-structure-and-code-pins-only',runId:normalizeLoopRequest(request).runId,providerCalls:0,collectionCalls:0};
}
if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)console.log(JSON.stringify(generateMain()));
