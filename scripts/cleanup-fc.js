/**
 * Removes obsolete FC functions before `s deploy` so the deploy stays within
 * the 50-function-per-service limit.
 *
 * Strategy: the functions we WANT are exactly the ones declared in s.yaml.
 * Any function still living in the service that s.yaml no longer declares is
 * an orphan (renamed/removed endpoint, e.g. the old aiChat / aiQuota). We
 * delete those orphans up front, freeing slots for the new functions that
 * `s deploy` is about to create. This is self-maintaining — no hardcoded list
 * to keep in sync.
 */
const fs = require('fs');
const path = require('path');
const FC = require('@alicloud/fc2');

const SERVICE = 'fe-journey-faas';
const REGION = 'cn-hangzhou';

// Parse the FC function names (the `name:` directly under each `function:`
// block) out of s.yaml without pulling in a YAML dependency.
function desiredFunctionNames() {
  const yaml = fs.readFileSync(path.join(__dirname, '..', 's.yaml'), 'utf8');
  const lines = yaml.split('\n');
  const names = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'function:') continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^\s+name:\s*(.+)$/);
      if (m) {
        names.add(m[1].replace(/#.*/, '').trim());
        break;
      }
    }
  }
  return names;
}

async function listDeployedFunctions(client) {
  const names = [];
  let nextToken;
  do {
    const res = await client.listFunctions(SERVICE, { limit: 100, nextToken });
    const data = res.data || res;
    for (const fn of data.functions || []) names.push(fn.functionName);
    nextToken = data.nextToken;
  } while (nextToken);
  return names;
}

// FC refuses to delete a function that still has triggers, so clear them first.
async function deleteFunctionDeep(client, fn) {
  try {
    const res = await client.listTriggers(SERVICE, fn);
    const data = res.data || res;
    for (const t of data.triggers || []) {
      await client.deleteTrigger(SERVICE, fn, t.triggerName);
    }
  } catch (e) {
    // no triggers / already gone — fall through to deleteFunction
  }
  await client.deleteFunction(SERVICE, fn);
}

async function main() {
  const client = new FC(process.env.ALIBABA_CLOUD_ACCOUNT_ID, {
    accessKeyID: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    region: REGION,
    timeout: 30000,
  });

  const desired = desiredFunctionNames();
  console.log(`s.yaml declares ${desired.size} functions`);

  let deployed;
  try {
    deployed = await listDeployedFunctions(client);
  } catch (e) {
    if (e.code === 'ServiceNotFound') {
      console.log('⚠ Service does not exist yet — nothing to clean up');
      return;
    }
    throw e;
  }
  console.log(`Service '${SERVICE}' currently has ${deployed.length} functions`);

  const orphans = deployed.filter((n) => !desired.has(n));
  if (orphans.length === 0) {
    console.log('✓ No obsolete functions to remove');
    return;
  }

  console.log(`Removing ${orphans.length} obsolete function(s): ${orphans.join(', ')}`);
  for (const fn of orphans) {
    try {
      await deleteFunctionDeep(client, fn);
      console.log(`✓ Deleted obsolete function: ${fn}`);
    } catch (e) {
      console.log(`⚠ Skip ${fn}: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(0); // non-fatal — let the deploy step report the real outcome
});
