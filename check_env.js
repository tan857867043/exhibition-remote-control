const env = process.env;
const envVars = Object.entries(env).map(([key, val]) => ({
  name: key,
  length: (val || '').length + key.length + 2
}));
envVars.sort((a, b) => b.length - a.length);
const total = envVars.reduce((s, v) => s + v.length, 0);
console.log('Total env vars:', envVars.length);
console.log('Total encoded size (est):', total);
console.log('\nTop 20 largest env vars:');
envVars.slice(0, 20).forEach(v => {
  console.log(`  ${v.name}: ${v.length} chars`);
});
