const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const files = [
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  'icon.svg',
  'favicon.png',
  'logo.png'
];

files.forEach(f => {
  const src = path.join(__dirname, f);
  const dest = path.join(distDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`? Synced ${f} -> dist/${f}`);
  }
});

console.log('Dist build sync complete.');
