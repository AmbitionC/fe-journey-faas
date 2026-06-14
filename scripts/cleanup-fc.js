/**
 * Deletes obsolete FC functions to stay under the 50-function service limit.
 * Run before `s deploy` in CI.
 */
const FC = require('@alicloud/fc2');

const client = new FC(process.env.ALIBABA_CLOUD_ACCOUNT_ID, {
  accessKeyID: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
  region: 'cn-hangzhou',
  timeout: 30000,
});

const SERVICE = 'fe-journey-faas';

// Functions to remove: replaced by streaming endpoint or merged into getUserInfo
const TO_DELETE = ['aiChat', 'aiQuota'];

async function main() {
  for (const fn of TO_DELETE) {
    try {
      await client.deleteFunction(SERVICE, fn);
      console.log(`✓ Deleted function: ${fn}`);
    } catch (e) {
      if (e.code === 'FunctionNotFound') {
        console.log(`⚠ Already gone: ${fn}`);
      } else {
        console.log(`⚠ Skip ${fn}: ${e.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(0); // non-fatal — deploy should still proceed
});
