const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const sourcePath = path.join(__dirname, 'icon-source.png');
  const source = await fs.readFile(sourcePath);
  const circle = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="512" cy="512" r="512" fill="white"/></svg>');
  const insetArtwork = await sharp(source).resize(900, 900).png().toBuffer();
  const roundedIcon = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([
      { input: circle },
      { input: insetArtwork, left: 62, top: 62 },
      { input: circle, blend: 'dest-in' },
    ])
    .png()
    .toBuffer();
  const thumbnail = await sharp(roundedIcon).resize(256, 256).png().toBuffer();
  const dataUrl = `data:image/png;base64,${thumbnail.toString('base64')}`;
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image width="1024" height="1024" href="${dataUrl}"/></svg>`;
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map((size) =>
    sharp(roundedIcon).resize(size, size).png().toBuffer(),
  ));

  await fs.writeFile(path.join(__dirname, 'icon.svg'), iconSvg);
  await fs.writeFile(path.join(__dirname, 'icon.png'), roundedIcon);

  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  pngs.forEach((png, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index];
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  await fs.writeFile(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...pngs]));
  await fs.writeFile(path.join(__dirname, '..', 'public', 'favicon.svg'), iconSvg);

  const ogSvgPath = path.join(__dirname, '..', 'public', 'og-image.svg');
  let ogSvg = await fs.readFile(ogSvgPath, 'utf8');
  ogSvg = ogSvg.replace(/<g transform="translate\(132 130\)">[\s\S]*?(?=<text x="228")|<image x="132" y="130" width="72" height="72" href="[^"]+"\/>/,
    `<image x="132" y="130" width="72" height="72" href="${dataUrl}"/>`);
  await fs.writeFile(ogSvgPath, ogSvg);
  await sharp(Buffer.from(ogSvg)).png().toFile(path.join(__dirname, '..', 'public', 'og-image.png'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
