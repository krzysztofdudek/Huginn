const puppeteer = require("puppeteer");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const HTML_PATH = path.join(__dirname, "demo.html");
const FRAMES_DIR = path.join(__dirname, "frames");
const OUTPUT_GIF = path.join(__dirname, "demo.gif");

const WIDTH = 900;
const HEIGHT = 500;
const FPS = 12;
const DURATION = 19; // seconds
const TOTAL_FRAMES = FPS * DURATION;

async function main() {
  // Clean frames dir
  if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR);

  console.log("Launching browser...");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });

  console.log("Loading animation...");
  await page.goto("file://" + HTML_PATH, { waitUntil: "domcontentloaded" });

  console.log(`Capturing ${TOTAL_FRAMES} frames at ${FPS}fps (${DURATION}s)...`);
  const interval = 1000 / FPS;

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const framePath = path.join(FRAMES_DIR, `frame-${String(i).padStart(4, "0")}.png`);
    await page.screenshot({ path: framePath, type: "png" });

    if ((i + 1) % (FPS * 2) === 0) {
      console.log(`  ${i + 1}/${TOTAL_FRAMES} (${Math.round((i + 1) / TOTAL_FRAMES * 100)}%)`);
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  await browser.close();
  console.log("Frames captured.");

  // Convert to GIF using ffmpeg with palette for quality
  console.log("Generating GIF...");
  const palettePath = path.join(FRAMES_DIR, "palette.png");

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame-%04d.png" -vf "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=max_colors=128" "${palettePath}"`,
    { stdio: "pipe" }
  );

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${FRAMES_DIR}/frame-%04d.png" -i "${palettePath}" -lavfi "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "${OUTPUT_GIF}"`,
    { stdio: "pipe" }
  );

  // Clean up frames
  fs.rmSync(FRAMES_DIR, { recursive: true });

  const size = (fs.statSync(OUTPUT_GIF).size / 1024 / 1024).toFixed(1);
  console.log(`Done: ${OUTPUT_GIF} (${size}MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
