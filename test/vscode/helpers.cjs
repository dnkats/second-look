// Shared by the integration suites: polling, and a small test runner whose
// summary fails the run when a test failed.

async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) {
        return last;
      }
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}: ${last}`);
}

function suite() {
  const results = [];
  return {
    async test(name, fn) {
      try {
        await fn();
        results.push(`ok ${name}`);
      } catch (e) {
        results.push(`FAIL ${name}: ${e.stack || e}`);
      }
    },
    done() {
      const failed = results.filter((r) => r.startsWith('FAIL'));
      console.log(results.join('\n'));
      if (failed.length > 0) {
        throw new Error(`${failed.length} of ${results.length} integration tests failed`);
      }
    },
  };
}

module.exports = { until, suite };
