// Иконка Aurora: чистая «A» на градиенте, без лишних элементов.
// Изображение собирается вручную в PNG — без внешних конвертеров.
import zlib from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const size = 256
const px = Buffer.alloc(size * size * 4)

const lerp = (a, b, t) => a + (b - a) * t
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const c1 = hex('#7c5cff'), c2 = hex('#00d6bd')

// Скруглённый квадрат.
const inRoundRect = (x, y, r) => {
  const dx = x < r ? r - x : (x > size - r ? x - (size - r) : 0)
  const dy = y < r ? r - y : (y > size - r ? y - (size - r) : 0)
  return dx * dx + dy * dy <= r * r
}

// Буква A: внешний треугольник с внутренним вырезом и перемычкой.
const inA = (x, y) => {
  const t = (y - 56) / 144
  if (t < 0 || t > 1) return false
  const half = lerp(16, 62, t)
  const cx = 128
  if (Math.abs(x - cx) > half) return false
  if (t < 0.08) return true
  // Внутренний вырез начинается ниже вершины.
  const cutHalf = lerp(2, 36, (t - 0.08) / 0.92)
  if (t < 0.88 && Math.abs(x - cx) < cutHalf) return false
  // Перемычка.
  if (y >= 158 && y <= 178) return true
  return true
}

for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    if (!inRoundRect(x, y, 58)) { px[i + 3] = 0; continue }
    const t = (x / size + y / size) / 2
    let r = lerp(c1[0], c2[0], t), g = lerp(c1[1], c2[1], t), b = lerp(c1[2], c2[2], t)
    if (inA(x, y)) { r = 255; g = 255; b = 255 }
    px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = 255
  }
}

const raw = Buffer.alloc(size * (size * 4 + 1))
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0
  px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc)
  return Buffer.concat([len, body, crcBuf])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('PNG:', png.length, 'байт')