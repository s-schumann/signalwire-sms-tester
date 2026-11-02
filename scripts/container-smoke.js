// Opt-in: requires Docker, a locally built image, and HTTPS egress to nodejs.org.
// Uses synthetic service authentication and NO provider credentials or SMS calls.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] || 'signalwire-sms-tester:local';
const name = `sms-tester-smoke-${randomUUID()}`;
const volume = `${name}-data`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
try {
  docker('volume', 'create', volume);
  docker('run', '-d', '--name', name, '-e', 'API_KEY=synthetic-container-test-key', '-v', `${volume}:/app/data`, image);
  const result = docker('exec', name, 'node', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import { readFile, writeFile, unlink, access, stat } from 'node:fs/promises';
    import { constants } from 'node:fs';
    assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
    assert.equal((await stat('/app/src/server.js')).uid, 0);
    await assert.rejects(access('/app/src/server.js', constants.W_OK), {code:'EACCES'});
    await assert.rejects(access('/app/package.json', constants.W_OK), {code:'EACCES'});
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
    let health;
    for (let i=0;i<50;i++) {
      try { health = await fetch('http://127.0.0.1:3000/health'); break; }
      catch { await new Promise(r=>setTimeout(r, 50)); }
    }
    assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
    const index = await fetch('http://127.0.0.1:3000/', {headers:{authorization:'Bearer synthetic-container-test-key'}});
    assert.equal(index.status, 200);
    const info = await index.json();
    assert.equal(info.configuration.sendConfigured, false);
    assert.equal(info.version, JSON.parse(await readFile('package.json', 'utf8')).version);
    assert.equal((await fetch('http://127.0.0.1:3000/')).status, 401);
    await writeFile('/app/data/write-probe', 'ok');
    assert.equal(await readFile('/app/data/write-probe','utf8'),'ok');
    assert.equal((await stat('/app/data/write-probe')).uid,1000); await unlink('/app/data/write-probe');
    assert.match(await readFile('/etc/ssl/certs/ca-certificates.crt','utf8'), /BEGIN CERTIFICATE/);
    await assert.rejects(access('/bin/sh'), {code:'ENOENT'});
    const https = await fetch('https://nodejs.org/', {signal:AbortSignal.timeout(10000)});
    assert.equal(https.ok,true); await https.body.cancel();
    console.log(JSON.stringify({version:info.version,node:process.versions.node,arch:process.arch,uid:process.getuid(),health:true,authenticatedRead:true,applicationReadOnlyToRuntime:true,mountedWrite:true,httpsCertificateValidation:true,shellAbsent:true}));
  `);
  console.log(result);
  const healthcheck = JSON.parse(docker('inspect', '--format', '{{json .Config.Healthcheck.Test}}', name));
  if (healthcheck[0] !== 'CMD') throw new Error('Expected a shell-free CMD healthcheck');
  docker('exec', name, ...healthcheck.slice(1));
  docker('stop', '--time', '12', name);
  if (docker('inspect', '--format', '{{.State.ExitCode}}', name) !== '0') throw new Error('Container did not shut down cleanly');
  console.log(docker('run', '--rm', '-v', `${volume}:/app/data`, image, 'node', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    const rows=(await readFile('/app/data/events.jsonl','utf8')).trim().split('\n').map(s=>JSON.parse(s));
    const startup=rows.find(row=>row.type==='service_started');
    assert.equal(startup.version,JSON.parse(await readFile('package.json','utf8')).version);
    assert.equal(startup.nodeVersion,process.versions.node);
    assert.equal(startup.requireDeliveredStatus,false);
    assert.equal(startup.ignoreSenderFrom,false);
    assert.ok(!rows.some(row=>row.type==='test_started'||row.type==='raw_send_started'));
    console.log('Versioned startup and persistent event log verified; no SMS sends; SIGTERM exit 0');
  `));
} finally {
  try { docker('rm', '-f', name); } catch { /* May not have started. */ }
  try { docker('volume', 'rm', volume); } catch { /* Reported by Docker. */ }
}
