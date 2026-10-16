'use strict';
// Root-owned host-only reconciler. NEVER packaged/mounted into Pluton.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const persistent = require('../persistent-restore/operator.cjs');
const systemdStorage = require('./systemdStorage.cjs');
// Host-observed mailbox revisions, not a new caller-selected protocol field.
const requestRevisions = new WeakMap();
function observeContainer(op,meta,storage){
  storage.resume(meta.volume);
  const info=op.inspect(meta);
  if(info.State.Running)op.nativeReady(meta);
  // A daemon/guest restart stops retained containers (restart=no). Reconcile
  // the public target state as well as the lifecycle receipt; otherwise the
  // application's retained-state view still says Active and hides Resume.
  else op.state(meta,'stopped');
  return {meta,running:info.State.Running};
}
// Host-code-only profiles allow a genuinely separate VM/disk rehearsal. They
// are never read from environment variables, application requests or CLI flags.
function createLifecycleOperator(options={}){
const ROOT = options.root||'/etc/pluton-automatic-recovery';
const DATA = options.data||'/var/lib/pluton-automatic-recovery';
const REQUESTS = options.requests||'/var/lib/pluton-automatic-recovery-requests';
const retained=options.persistent||{root:'/etc/pluton-persistent-restores',data:'/var/lib/pluton-persistent-restores',
  requests:'/var/lib/pluton-persistent-restore-requests',network:'pluton-persistent-restores'};
const storage=systemdStorage.createSystemdStorage([
  {images:retained.data+'/images',view:retained.data+'/view',readonlyView:retained.data+'/app-view',readonlyStage:retained.data+'/readonly-stage'},
  {images:DATA+'/disposable/images',view:DATA+'/disposable/view',readonlyView:DATA+'/disposable/app-view',readonlyStage:DATA+'/disposable/readonly-stage'}
],{dockerUnit:options.dockerUnit||'docker.service'});
const PUBLIC = ROOT+'/public';
const PURPOSE = 'pluton-phase6-recovery-only';
const env = {PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',
  DOCKER_HOST:options.dockerSocket?'unix://'+options.dockerSocket:'unix:///var/run/docker.sock',DOCKER_CONFIG:ROOT+'/docker-cli'};
const run = (bin,args,timeout=60000)=>execFileSync(bin,args,{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:65536,env,stdio:['ignore','pipe','pipe']}).trim();
const fail = code=>{throw Object.assign(new Error('Automatic recovery operator refused.'),{code});};
const keys = (value, expected)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',')===expected.split(',').sort().join(',');
const hex=(value,size)=>typeof value==='string' && new RegExp('^[a-f0-9]{'+size+'}$').test(value);
function assertMountNamespace(self,host){
  if(!/^mnt:\[\d+\]$/.test(self)||self!==host)fail('operator-mount-namespace-unapproved');
}
function validate(value, now=Date.now()){
  if(!keys(value,'version,binding,ownerToken,action,cleanupReady') || value.version!==1 ||
    !hex(value.ownerToken,48)||!['provision','inspect','stop','resume','delete'].includes(value.action)||typeof value.cleanupReady!=='boolean')fail('request-unsafe');
  const b=value.binding;
  if(!keys(b,'id,mode,engine,snapshotId,artifacts,createdAt,expiresAt') || !hex(b.id,24)||!hex(b.snapshotId,64)||
    !['persistent','disposable'].includes(b.mode)||!Object.hasOwn(persistent.images,b.engine)||
    !Array.isArray(b.artifacts)||!b.artifacts.length||b.artifacts.length>8||
    (b.mode==='persistent'&&b.artifacts.length!==1)||!Number.isSafeInteger(b.createdAt)||!Number.isSafeInteger(b.expiresAt)||
    b.createdAt<=0||b.createdAt>now+5000||b.expiresAt<=b.createdAt||b.expiresAt-b.createdAt>30*86400_000 ||
    b.artifacts.some(a=>!keys(a,'databaseId,database,sha256,bytes')||!/^db_[A-Za-z0-9_-]{1,80}$/.test(a.databaseId)||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(a.database)||
      ['mysql','sys','postgres','template0','template1','information_schema','performance_schema','pluton_recovery_guard','pluton_restore_guard'].includes(a.database.toLowerCase())||
      !hex(a.sha256,64)||!Number.isSafeInteger(a.bytes)||a.bytes<=0||a.bytes>448*1024**2)||
    new Set(b.artifacts.map(a=>a.database)).size!==b.artifacts.length||
    new Set(b.artifacts.map(a=>a.databaseId)).size!==b.artifacts.length||
    (b.mode==='disposable'&&['stop','resume'].includes(value.action)))fail('request-unsafe');
  return value;
}
function hash(req){return crypto.createHash('sha256').update(JSON.stringify(req.binding)).update(req.ownerToken).digest('hex');}
function rootRead(file,max=65536){
  storage.rootParent(file);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const st=fs.fstatSync(fd);
    if(!st.isFile()||st.uid!==0||(st.mode&0o027)||st.nlink!==1||st.size>max)fail('operator-state-unsafe');
    return JSON.parse(fs.readFileSync(fd,'utf8'));
  }finally{fs.closeSync(fd);}
}
function readRequest(id){
  if(!hex(id,24))fail('request-unsafe');
  storage.directory(REQUESTS,10001,10001,0o700);
  // UID 10001 owns this directory: reject special files without blocking open,
  // and bound the actual read, not only the size observed before a racing write.
  const fd=fs.openSync(path.join(REQUESTS,id+'.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const st=fs.fstatSync(fd,{bigint:true});
    if(!st.isFile()||st.uid!==10001n||(st.mode&0o777n)!==0o600n||st.nlink!==1n||st.size>8192n)fail('request-unsafe');
    const bytes=Buffer.alloc(8193);let length=0,count;
    do{
      count=fs.readSync(fd,bytes,length,bytes.length-length,length);length+=count;
      if(length>8192)fail('request-unsafe');
    }while(count);
    const raw=bytes.subarray(0,length).toString('utf8'),after=fs.fstatSync(fd,{bigint:true});
    if(BigInt(length)!==st.size||st.size!==after.size||st.mtimeNs!==after.mtimeNs||st.ctimeNs!==after.ctimeNs)fail('request-unsafe');
    const req=validate(JSON.parse(raw));
    if(req.binding.id!==id)fail('request-unsafe');
    requestRevisions.set(req,crypto.createHash('sha256').update([st.dev,st.ino,st.mtimeNs,st.ctimeNs].join(':')).update(raw).digest('hex'));
    return req;
  }finally{fs.closeSync(fd);}
}
function policy(){
  const p=rootRead(ROOT+'/policy.json',2048);
  if(!keys(p,'version,enabled,maxSqlBytes,maxRetentionSeconds')||p.version!==1||p.enabled!==true||
    !Number.isSafeInteger(p.maxSqlBytes)||p.maxSqlBytes<1||p.maxSqlBytes>448*1024**2||
    !Number.isSafeInteger(p.maxRetentionSeconds)||p.maxRetentionSeconds<86400||p.maxRetentionSeconds>30*86400)fail('operator-policy-unsafe');
  return p;
}
function disposableSql(names,engine,_database,password,activation,storageId,username){
  if(engine==='mariadb')return 'CREATE DATABASE pluton_recovery_guard;\n'+
    'CREATE TABLE pluton_recovery_guard.pluton_recovery_guard(purpose VARCHAR(64),activation_id VARCHAR(32),storage_id VARCHAR(36));\n'+
    "INSERT INTO pluton_recovery_guard.pluton_recovery_guard VALUES ('"+PURPOSE+"','"+activation+"','"+storageId+"');\n"+
    "CREATE USER '"+username+"'@'%' IDENTIFIED BY '"+password+"' REQUIRE SSL;\n"+
    "GRANT SELECT ON pluton_recovery_guard.pluton_recovery_guard TO '"+username+"'@'%';\n"+
    names.map(name=>"GRANT ALL PRIVILEGES ON \x60"+name.replaceAll('_','\\_')+"\x60.* TO '"+username+"'@'%';").join('\n')+'\n';
  return 'CREATE DATABASE pluton_recovery_guard;\n\\connect pluton_recovery_guard\n'+
    'CREATE TABLE pluton_recovery_guard(purpose VARCHAR(64),activation_id VARCHAR(32),storage_id VARCHAR(36));\n'+
    "INSERT INTO pluton_recovery_guard VALUES ('"+PURPOSE+"','"+activation+"','"+storageId+"');\n"+
    "CREATE ROLE "+username+" LOGIN PASSWORD '"+password+"' NOSUPERUSER CREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6;\n"+
    'REVOKE ALL ON DATABASE pluton_recovery_guard FROM PUBLIC;\n'+
    'GRANT CONNECT ON DATABASE pluton_recovery_guard TO '+username+';\n'+
    'GRANT USAGE ON SCHEMA public TO '+username+';\nGRANT SELECT ON pluton_recovery_guard TO '+username+';\nALTER ROLE postgres NOLOGIN;\n';
}
function engineDriver(req, stage){
  const b=req.binding;
  const common={automatic:true,stage,bindingHash:req.ownerToken?hash(req):'',mode:b.mode,
    lock:options.lock||'pluton-automatic-recovery-lock',storage,dockerSocket:options.dockerSocket,dockerConfig:ROOT+'/docker-cli',
    installationId:rootRead(ROOT+'/installation.json').installationId};
  return persistent.createOperator(b.mode==='persistent'?{...common,...retained,appView:retained.data+'/app-view'}:{
    ...common,root:ROOT+'/disposable',data:DATA+'/disposable',requests:DATA+'/unused-requests',
    network:options.disposableNetwork||'pluton-automatic-tests',purpose:PURPOSE,disposable:true,appView:DATA+'/disposable/app-view',
    bootstrapSql:disposableSql.bind(null,b.artifacts.map(a=>a.database))
  });
}
function legacyRequest(req, meta){
  const b=req.binding,a=b.artifacts[0];
  return {version:1,purpose:b.mode==='persistent'?persistent.PURPOSE:PURPOSE,mode:'internal',
    action:req.action==='inspect'?'provision':req.action,restoreId:b.id,snapshotId:b.snapshotId,databaseId:a.databaseId,
    engine:b.engine,database:a.database,sha256:a.sha256,bytes:b.artifacts.reduce((n,a)=>n+a.bytes,0),
    expiresAt:b.expiresAt,cleanupReady:req.cleanupReady,targetFingerprint:meta?.fingerprint||null};
}
function driver(req,stage){
  const op=engineDriver(req,stage),id=req.binding.id;
  const exists=()=>fs.existsSync(path.join(op.ROOT,'private',id,'metadata.json'));
  const noManual=()=>{
    if(run('docker',['container','ls','--filter','volume=pluton-internal-recovery-lock','--format','{{.ID}}']))fail('internal-lifecycle-busy');
  };
  return {
    exists,
    admit:()=>{
      op.resourceAdmission(req.binding.artifacts.reduce((n,a)=>n+a.bytes,0));
      const cpus=os.availableParallelism();
      if(cpus<2||os.loadavg()[0]>cpus*1.5)fail('resource-cpu-insufficient');
      const capacity=fs.statfsSync(op.DATA+'/images');
      if(capacity.bavail*capacity.bsize<3*1024**3)fail('resource-disk-insufficient');
      run('docker',['image','inspect',persistent.images[req.binding.engine]]);
      // No second native engine from manual mode may be displaced or compete for the shared lock.
      noManual();
    },
    busy:()=>fs.readdirSync(ROOT+'/journal').some(name=>{
      if(!/^[a-f0-9]{24}\.json$/.test(name)||name===id+'.json')return false;
      return rootRead(ROOT+'/journal/'+name).state!=='removed';
    }),
    provision:()=>{
      run('docker',['image','inspect',persistent.images[req.binding.engine]]); // No registry dependency or implicit pull.
      op.provision(legacyRequest(req));return op.metadata(id);
    },
    inspect:()=>{
      const meta=op.metadata(id);
      op.bindRequest(meta,legacyRequest(req,meta));
      return observeContainer(op,meta,storage);
    },
    stop:meta=>{run('docker',['stop','--time','30',meta.containerId]);if(op.inspect(meta).State.Running)fail('container-stop-unverified');op.state(meta,'stopped');},
    resume:meta=>{
      noManual();
      op.resourceAdmission(req.binding.artifacts.reduce((sum,a)=>sum+a.bytes,0));
      storage.resume(meta.volume);run('docker',['start',meta.containerId]);op.nativeReady(meta);op.state(meta,'active');
    },
    remove:(meta=op.metadata(id))=>{
      op.deleteOwned(meta,{...legacyRequest(req,meta),action:'delete',cleanupReady:true});
      const file=PUBLIC+'/'+id+'.target.json';
      if(fs.existsSync(file)){
        if(rootRead(file).bindingHash!==hash(req))fail('credential-cleanup-uncertain');
        fs.unlinkSync(file);
      }
    },
    absent:()=>op.verifyNeverProvisioned({...legacyRequest(req),action:'delete',cleanupReady:false}),
    publish:meta=>{
      op.publish(meta);
      if(req.binding.mode==='disposable'){
        const target={version:1,id,engine:req.binding.engine,target:meta.approval.target,installationId:rootRead(ROOT+'/installation.json').installationId,
          activationId:meta.approval.activationId,caSha256:meta.approval.caSha256,storage:meta.approval.storage,containerId:meta.containerId,bindingHash:hash(req)};
        persistent.write(PUBLIC+'/'+id+'-ca.pem',fs.readFileSync(op.ROOT+'/public/'+id+'-ca.pem','utf8'),10001,0o640);
        persistent.write(PUBLIC+'/'+id+'.target.json',target,10001,0o640);
      }
    }
  };
}
/** Pure decision layer; adapters allow deterministic crash tests without production test bypass flags. */
function reconcile(req, journal, io, emit, now=Date.now(), revision=requestRevisions.get(req)){
  validate(req,now);
  if(journal && journal.bindingHash!==hash(req))fail('ownership-token-mismatch');
  if(journal?.state==='removed'){emit('removed');return;}
  if(journal?.deleting && req.action!=='delete')fail('deletion-in-progress');
  if(journal?.cancelled && req.action!=='delete')fail('deletion-in-progress');
  if(io.exists()&&!journal?.attempted)fail('resource-name-collision');
  const ready=()=>emit('ready',{readyOnce:true});
  if(req.action==='provision'){
    if(req.binding.expiresAt<=now)fail('request-expired');
    if(io.busy())fail('internal-lifecycle-busy');
    if(io.exists()){
      const {meta,running}=io.inspect();
      if(!running && journal?.readyOnce){emit('stopped');return;}
      if(!running)io.resume(meta); // Exact created-but-never-ready identity, not a replay of SQL.
      io.publish(meta);ready();return;
    }
    if(journal?.attempted)fail('partial-provisioning-uncertain');
    emit('checking-resources');
    io.admit();
    emit('provisioning-container',{attempted:true}); // Durable BEFORE image/storage/container mutation.
    const meta=io.provision();io.publish(meta);ready();return;
  }
  if(req.action==='delete'){
    if(journal?.deleting){io.remove();emit('removed',{deleting:true});return;}
    if(!io.exists()){io.absent();emit('removed',{deleting:true});return;}
    emit('cleaning-up',{cancelled:true});
    const {meta,running}=io.inspect();
    if(!req.cleanupReady){
      if(!running)io.resume(meta); // Native ownership cleanup must finish before physical deletion.
      io.publish(meta);ready();return;
    }
    emit('cleaning-up',{deleting:true});
    io.remove(meta);emit('removed',{deleting:true});return;
  }
  const {meta,running}=io.inspect();
  if(req.action==='stop'){if(running)io.stop(meta);emit('stopped');}
  else if(req.action==='resume'){
    if(req.binding.expiresAt<=now)fail('request-expired');
    if(io.busy())fail('internal-lifecycle-busy');
    // Resume is a one-shot control request, not a container restart policy.
    // A durable consumed revision prevents the still-present mailbox from
    // re-starting a retained DB after a later daemon/guest restart. An explicit
    // new API action atomically publishes a new inode/ctime revision.
    if(!running&&revision&&(journal.resumeRevision===revision||journal.state==='ready')){
      emit('stopped',{resumeRevision:revision});return;
    }
    if(!running){emit('starting-database',revision?{resumeRevision:revision}:{});io.resume(meta);}
    io.publish(meta);emit('ready',{readyOnce:true,...(revision?{resumeRevision:revision}:{})});
  }else {if(running)io.publish(meta);emit(running?'ready':'stopped');}
}
function tick(){
  storage.assertEnvironment();
  const p=policy(),install=rootRead(ROOT+'/installation.json');
  if(install.version!==1||!hex(install.installationId,32))fail('operator-state-unsafe');
  const files=fs.readdirSync(REQUESTS).filter(n=>/^[a-f0-9]{24}\.json$/.test(n));
  if(files.length>64)fail('request-count-limit');
  persistent.write(PUBLIC+'/capabilities.json',{version:1,engines:['mariadb','postgresql'],maxSqlBytes:p.maxSqlBytes,
    quotaBytes:2147483648,maxRetentionSeconds:p.maxRetentionSeconds,observedAt:Date.now()},10001,0o640);
  for(const file of files.slice(0,64)){
    const id=file.slice(0,24),journalFile=ROOT+'/journal/'+file;
    let req,journal;
    try{
      req=readRequest(id);journal=fs.existsSync(journalFile)?rootRead(journalFile):null;
      const b=req.binding,bytes=b.artifacts.reduce((n,a)=>n+a.bytes,0);
      if(['provision','resume'].includes(req.action) && (bytes>p.maxSqlBytes||bytes*4+256*1024**2>2147483648||b.expiresAt-b.createdAt>
        (b.mode==='disposable'?7200:p.maxRetentionSeconds)*1000))fail('operator-budget-refused');
      if(!journal){
        if(fs.readdirSync(ROOT+'/journal').length>=4096)fail('operator-audit-capacity');
        journal={version:1,bindingHash:hash(req),binding:b,state:'requested',sequence:0,attempted:false,deleting:false,createdAt:Date.now()};
        persistent.write(journalFile,journal);
      }
      const emit=(state,patch={})=>{
        journal={...journal,...patch,state,sequence:(journal.sequence||0)+1};persistent.write(journalFile,journal);
        persistent.write(PUBLIC+'/'+id+'.receipt.json',{version:1,id,bindingHash:journal.bindingHash,state,code:null,
          observedAt:Date.now(),sequence:journal.sequence},10001,0o640);
      };
      reconcile(req,journal,driver(req,stage=>emit(stage)),emit);
    }catch(error){
      const allowed=['request-expired','operator-budget-refused','internal-lifecycle-busy','ownership-token-mismatch','partial-provisioning-uncertain',
        'resource-admission-refused','resource-cpu-insufficient','resource-disk-insufficient','resource-name-collision',
        'target-authentication-failed','target-tls-failed','target-readiness-failed','target-readiness-timeout','target-purpose-mismatch',
        'target-process-stopped','operator-mount-unverified'];
      const code=allowed.includes(error.code)?error.code:'operator-resource-uncertain';
      if(req && journal?.bindingHash===hash(req)){
        journal={...journal,state:'cleanup-required',sequence:(journal.sequence||0)+1};
        persistent.write(journalFile,journal);
        persistent.write(PUBLIC+'/'+id+'.receipt.json',{version:1,id,bindingHash:journal.bindingHash,
          state:'cleanup-required',code,observedAt:Date.now(),sequence:journal.sequence},10001,0o640);
      }
      process.stderr.write(JSON.stringify({event:'automatic_recovery_refused',id,code})+'\n');
    }
  }
}
function init(){
  if(fs.existsSync(ROOT))fail('installation-already-exists');
  storage.rootParent(ROOT);fs.mkdirSync(ROOT,{mode:0o755});fs.chmodSync(ROOT,0o755);
  storage.directory(ROOT+'/journal');storage.directory(ROOT+'/docker-cli');
  fs.mkdirSync(PUBLIC,{mode:0o750});fs.chownSync(PUBLIC,0,10001);fs.chmodSync(PUBLIC,0o750);
  storage.directory(DATA);storage.directory(DATA+'/disposable');
  fs.mkdirSync(REQUESTS,{mode:0o700});fs.chownSync(REQUESTS,10001,10001);
  persistent.write(ROOT+'/installation.json',{version:1,installationId:crypto.randomBytes(16).toString('hex')});
  persistent.write(ROOT+'/policy.json',{version:1,enabled:false,maxSqlBytes:128*1024**2,maxRetentionSeconds:86400});
  // Explicit privileged installation only. Never invoked by the application or normal image deployment.
  engineDriver({binding:{mode:'persistent',artifacts:[]}}).init();
  engineDriver({binding:{mode:'disposable',artifacts:[]}}).init();
  storage.initializeViews();
}
function main(){
  try{
    if(process.platform!=='linux'||process.getuid()!==0||Number(process.versions.node.split('.')[0])<20)fail('root-linux-node20-required');
    persistent.rootCode(__filename);persistent.rootCode(path.join(__dirname,'../persistent-restore/operator.cjs'));
    persistent.rootCode(path.join(__dirname,'../persistent-restore/storage.cjs'));
    persistent.rootCode(path.join(__dirname,'systemdStorage.cjs'));
    const action=process.argv[2];if(process.argv.length!==3||!['init','tick','anchors'].includes(action))fail('operation-not-supported');
    // Installation creates the view bind anchors in the host namespace only.
    // Tick uses PID-1-managed mount units and retains PrivateTmp/ProtectHome.
    if(action==='init'){
      assertMountNamespace(fs.readlinkSync('/proc/self/ns/mnt'),fs.readlinkSync('/proc/1/ns/mnt'));init();
    }
    else if(action==='anchors')storage.assertAnchors();
    else if(process.env.PLUTON_AUTOMATIC_OPERATOR_LOCK!=='held'){
      execFileSync('/usr/bin/flock',['--exclusive','--nonblock','/run/pluton-automatic-recovery.lock',process.execPath,__filename,'tick'],
        {env:{...env,PLUTON_AUTOMATIC_OPERATOR_LOCK:'held'},timeout:240000,stdio:['ignore','pipe','pipe'],maxBuffer:65536});
    }else tick();
  }catch(error){
    process.stderr.write(error.code==='operator-mount-namespace-unapproved'?
      'Automatic recovery refused: operator-mount-namespace-unapproved. Separate host security approval is required.\n':
      'Automatic recovery operator failed closed. Inspect ownership and the sanitized receipt.\n');process.exitCode=1;
  }
}
return {validate,hash,reconcile,disposableSql,driver,legacyRequest,assertMountNamespace,readRequest,init,tick,main,
  ROOT,DATA,REQUESTS,PUBLIC,engineDriver,assertAnchors:storage.assertAnchors,initializeViews:storage.initializeViews};
}
module.exports={...createLifecycleOperator(),createLifecycleOperator,observeContainer};
if(require.main===module)module.exports.main();
