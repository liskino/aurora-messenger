// Проверка встроенного STUN/TURN: запускаем и убеждаемся, что он отвечает.
import { createRequire } from 'node:module'
import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const Turn = require('node-turn')

const PORT = 34780

const server = new Turn({
  authMech: 'long-term',
  credentials: { aurora: 'test-password' },
  listeningPort: PORT,
  debugLevel: 'OFF',
})

server.start()

await new Promise((r) => setTimeout(r, 800))

// Отправляем STUN-запрос Binding вручную: так проверяем, что сервер
// действительно разбирает протокол, а не просто слушает порт.
function stunBindingRequest() {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0) // Binding Request
  buf.writeUInt16BE(0, 2) // length
  buf.writeUInt32BE(0x2112a442, 4) // magic cookie
  randomBytes(12).copy(buf, 8) // transaction id
  return buf
}

const socket = dgram.createSocket('udp4')

const response = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 3000)

  socket.on('message', (msg) => {
    clearTimeout(timer)
    resolve(msg)
  })

  socket.send(stunBindingRequest(), PORT, '127.0.0.1', (err) => {
    if (err) resolve(null)
  })
})

socket.close()
server.stop()

if (!response) {
  console.log('STUN: НЕТ ОТВЕТА')
  process.exit(1)
}

const msgType = response.readUInt16BE(0)
const cookie = response.readUInt32BE(4)
const isSuccess = msgType === 0x0101
const cookieOk = cookie === 0x2112a442

console.log('STUN ответ получен:', response.length, 'байт')
console.log('тип ответа:', '0x' + msgType.toString(16), isSuccess ? '(Binding Success)' : '(ожидался 0x101)')
console.log('magic cookie:', cookieOk ? 'верный' : 'НЕВЕРНЫЙ')
console.log(isSuccess && cookieOk ? '\nSTUN/TURN работает' : '\nОШИБКА')

process.exit(isSuccess && cookieOk ? 0 : 1)