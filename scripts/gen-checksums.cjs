// scripts/gen-checksums.cjs
const c = require('crypto');
const fs = require('fs');
const path = require('path');

const files = [
  'brain.json',
  'meta.bin',
  'readout.json',
  'readout.trained.json',
  'readout.trial-and-error.json',
  'weights.0.bin',
  'weights.1.bin'
];

const out = {
  version: 1,
  generated: new Date().toISOString(),
  source: 'https://github.com/chnak/fly/tree/main/fixtures',
  total_size: 0,
  total_files: files.length,
  files: files.map(f => {
    const buf = fs.readFileSync(path.join('fixtures', f));
    return {
      path: f,
      size: buf.length,
      sha256: c.createHash('sha256').update(buf).digest('hex')
    };
  })
};
out.total_size = out.files.reduce((s, f) => s + f.size, 0);

const dest = path.join('fixtures', 'checksums.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${dest}`);
console.log(`Total: ${out.total_files} files, ${(out.total_size / 1024 / 1024).toFixed(2)} MB`);
for (const f of out.files) {
  console.log(`  ${String(f.size).padStart(10)}  ${f.sha256.slice(0, 12)}…  ${f.path}`);
}