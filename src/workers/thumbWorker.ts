// thumbWorker.js
import { parentPort } from "worker_threads";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import heicConvert from "heic-convert";

async function ensureThumbnail(srcPath: string, thumbPath: string, size = 256) {
  // Skip invalid or hidden files
  if (!fs.existsSync(srcPath)) return null;
  const ext = path.extname(srcPath).toLowerCase();
  const supported = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".heic", ".heif", ".tiff"];
  if (!supported.includes(ext)) throw new Error("Unsupported file type");

  // Ensure thumbnail directory
  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });

  try {
    if (ext === ".heic" || ext === ".heif") {
      // Read and convert HEIC manually
      const inputBuffer = fs.readFileSync(srcPath);
      // Convert Node.js Buffer to ArrayBuffer for heic-convert
      const arrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength);
      const outputBuffer = await heicConvert({
        buffer: arrayBuffer,
        format: "JPEG",
        quality: 0.8,
      });
      // Ensure sharp receives a Node Buffer
      await sharp(Buffer.from(outputBuffer))
        .resize(size, size, { fit: "inside" })
        .toFile(thumbPath);
    } else {
      await sharp(srcPath)
        .resize(size, size, { fit: "inside" })
        .toFile(thumbPath);
    }
    return thumbPath;
  } catch (err) {
    throw new Error(`Thumbnail failed for ${path.basename(srcPath)}: ${err.message}`);
  }
}

parentPort.on("message", async (msg) => {
  const { srcPath, thumbPath, size } = msg;
  try {
    const result = await ensureThumbnail(srcPath, thumbPath, size);
    parentPort.postMessage({ success: true, thumbPath: result });
  } catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
  }
});
