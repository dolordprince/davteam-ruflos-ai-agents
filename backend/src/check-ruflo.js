// backend/src/check-ruflo.js — Verify the real Ruflo runtime is available.
import { rufloAvailable, getRufloVersion, runDoctor } from './ruflo-runtime.js';

async function main() {
  console.log('Checking Ruflo runtime...\n');
  console.log(`  rufloAvailable: ${rufloAvailable}`);

  const ver = await getRufloVersion();
  console.log(`  Version:        ${ver.version || 'NOT FOUND'}`);
  console.log(`  Available:      ${ver.available}`);

  if (!rufloAvailable) {
    console.error('\n✗ Ruflo runtime NOT available. Run: npm install');
    process.exit(1);
  }

  console.log('\nRunning doctor --component metaharness...');
  try {
    const result = await runDoctor('metaharness');
    console.log(`  exitCode: ${result.exitCode}`);
    console.log(result.stdout);
  } catch (err) {
    console.error(`  doctor error: ${err.message}`);
  }

  console.log('\n✓ Ruflo runtime check complete.');
  process.exit(0);
}

main();
