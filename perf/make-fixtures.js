// perf/make-fixtures.js
// Generates the image fixtures the load tests need (not committed: they are
// large and reproducible). Uses sharp, which the app already depends on.
//
//   node perf/make-fixtures.js                     -> perf/fixtures/heavy.jpg
//   node perf/make-fixtures.js --huge 16000x16000  -> also perf/fixtures/huge-pixels.png
//
// heavy.jpg:       a ~2 megapixel photo-like JPEG (< 5 MB, the API's body limit),
//                  used for the "heavy image conversion" (jpeg -> avif) requests.
// huge-pixels.png: a tiny-on-disk PNG with enormous pixel dimensions, for the
//                  memory experiment (docs/perf/baseline.md, experiment 3). A
//                  solid colour compresses ~1000:1, so it fits under 5 MB while
//                  decoding to hundreds of MB. Keep width*height under sharp's
//                  default input limit (268,402,689 px) or sharp refuses it
//                  before decoding, which tests the limit, not memory.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const outDir = path.join(__dirname, 'fixtures');

async function heavyJpeg() {
  const width = 1920;
  const height = 1080;
  // Smooth gradient plus noise so it neither compresses to nothing nor to noise-sized bytes
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const noise = Math.floor(Math.random() * 40);
      raw[i] = Math.min(255, Math.floor((x / width) * 215) + noise);
      raw[i + 1] = Math.min(255, Math.floor((y / height) * 215) + noise);
      raw[i + 2] = Math.min(255, Math.floor(((x + y) / (width + height)) * 215) + noise);
    }
  }
  const file = path.join(outDir, 'heavy.jpg');
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(file);
  return file;
}

async function hugePng(dimensions) {
  const [width, height] = dimensions.split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`--huge needs WIDTHxHEIGHT, got "${dimensions}"`);
  }
  const file = path.join(outDir, 'huge-pixels.png');
  await sharp({ create: { width, height, channels: 3, background: '#3a6ea5' } })
    .png({ compressionLevel: 9 })
    .toFile(file);
  return file;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const files = [await heavyJpeg()];
  const hugeIndex = process.argv.indexOf('--huge');
  if (hugeIndex !== -1) files.push(await hugePng(process.argv[hugeIndex + 1] || '16000x16000'));

  for (const file of files) {
    const bytes = fs.statSync(file).size;
    const { width, height } = await sharp(file, { limitInputPixels: false }).metadata();
    console.log(
      `${path.relative(process.cwd(), file)}: ${width}x${height}, ${(bytes / 1024).toFixed(0)} KiB`
    );
    if (bytes > 5 * 1024 * 1024)
      console.warn('  WARNING: over the API 5 MB body limit, uploads will be rejected');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
