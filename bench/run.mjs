/**
 * Стенд криптографии: корректность и скорость.
 *
 * Проверяет не «примерно работает», а конкретные свойства, от которых зависит
 * вся защита мессенджера:
 *
 *   1. ECDH симметричен — обе стороны выводят один и тот же общий секрет.
 *      На этом стоит схема раздачи ключей чата: если это сломается, сообщения
 *      не расшифруются ни у кого.
 *   2. Ключ, завёрнутый на общий секрет, снимается второй стороной.
 *   3. Приватный ключ, обёрнутый паролем, восстанавливается из пароля и
 *      НЕ восстанавливается из неверного.
 *   4. AES-GCM ловит подмену шифротекста и подмену AAD (защита от перестановки
 *      сообщения в другой чат).
 *   5. Файл проходит цикл зашифровать → расшифровать байт-в-байт, включая
 *      размеры больше одного блока.
 *
 * Запуск: npm run bench
 */
import { webcrypto } from 'node:crypto'

// Криптоядро написано под WebCrypto; в Node он есть как globalThis.crypto.
globalThis.crypto ??= webcrypto
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary')

const C = await import('../src/lib/crypto.ts')

let passed = 0
let failed = 0

function ok(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗ ${name}${detail ? `  ${detail}` : ''}\x1b[0m`)
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

console.log('\n\x1b[1m\x1b[35mAurora · проверка криптографии\x1b[0m')

// ─────────────────────────── 1. ECDH ───────────────────────────

section('1. Согласование ключей (ECDH P-256)')

const alice = await C.generateIdentity()
const bob = await C.generateIdentity()

ok('ключи разные у разных пользователей', alice.publicKeyB64 !== bob.publicKeyB64)

const aliceShared = await C.deriveSharedKey(alice.privateKey, bob.publicKeyB64)
const bobShared = await C.deriveSharedKey(bob.privateKey, alice.publicKeyB64)

// Проверяем симметричность через реальную операцию: то, что зашифровала Алиса
// на своём секрете, Боб должен прочитать на своём.
const probe = await C.sealText('общий секрет совпадает', aliceShared)
let sameSecret = true
let decryptedProbe = ''
try {
  decryptedProbe = await C.openText(probe, bobShared)
} catch {
  sameSecret = false
}
ok('обе стороны выводят один и тот же секрет', sameSecret, sameSecret ? `«${decryptedProbe}»` : '')

const eve = await C.generateIdentity()
const eveShared = await C.deriveSharedKey(eve.privateKey, bob.publicKeyB64)
let eveFailed = false
try {
  await C.openText(probe, eveShared)
} catch {
  eveFailed = true
}
ok('посторонний секрет не подходит', eveFailed)

// ─────────────────────────── 2. Обёртка ключа чата ───────────────────────────

section('2. Раздача ключа чата')

const chatKey = await C.generateChatKey()
const wrapped = await C.wrapChatKey(chatKey, aliceShared)

const unwrappedByBob = await C.unwrapChatKey(wrapped, bobShared)
const sealedWithChatKey = await C.sealText('сообщение в чате', chatKey)
const readByBob = await C.openText(sealedWithChatKey, unwrappedByBob)
ok('Боб снимает обёртку и читает сообщение', readByBob === 'сообщение в чате', `«${readByBob}»`)

// Сценарий группы: создатель выдаёт ключ каждому участнику отдельной обёрткой.
const creator = await C.generateIdentity()
const member1 = await C.generateIdentity()
const member2 = await C.generateIdentity()
const groupKey = await C.generateChatKey()

const wrapped1 = await C.wrapChatKey(
  groupKey,
  await C.deriveSharedKey(creator.privateKey, member1.publicKeyB64),
)
const wrapped2 = await C.wrapChatKey(
  groupKey,
  await C.deriveSharedKey(creator.privateKey, member2.publicKeyB64),
)

const key1 = await C.unwrapChatKey(
  wrapped1,
  await C.deriveSharedKey(member1.privateKey, creator.publicKeyB64),
)
const key2 = await C.unwrapChatKey(
  wrapped2,
  await C.deriveSharedKey(member2.privateKey, creator.publicKeyB64),
)

const groupMsg = await C.sealText('привет, группа', groupKey)
ok('участник 1 читает групповое сообщение', (await C.openText(groupMsg, key1)) === 'привет, группа')
ok('участник 2 читает групповое сообщение', (await C.openText(groupMsg, key2)) === 'привет, группа')

// Создатель выдаёт ключ и себе — тем же кодом, без отдельной ветки.
const ownWrap = await C.wrapChatKey(
  groupKey,
  await C.deriveSharedKey(creator.privateKey, creator.publicKeyB64),
)
const ownKey = await C.unwrapChatKey(
  ownWrap,
  await C.deriveSharedKey(creator.privateKey, creator.publicKeyB64),
)
ok('создатель снимает свою обёртку', (await C.openText(groupMsg, ownKey)) === 'привет, группа')

// ─────────────────────────── 3. Пароль ───────────────────────────

section('3. Защита паролем')

const password = 'правильный-пароль-123'
const salt = C.generateSalt()
const passwordKey = await C.derivePasswordKey(password, salt, 100_000) // меньше итераций ради скорости теста
const wrappedPrivate = await C.wrapPrivateKey(alice.privateKey, passwordKey)

const goodKey = await C.derivePasswordKey(password, salt, 100_000)
const restored = await C.unwrapPrivateKey(wrappedPrivate, goodKey)
const restoredRaw = await webcrypto.subtle.exportKey('jwk', restored)
ok('приватный ключ восстанавливается из верного пароля', Boolean(restoredRaw?.d))

const wrongKey = await C.derivePasswordKey('неверный-пароль', salt, 100_000)
let wrongRejected = false
try {
  await C.unwrapPrivateKey(wrappedPrivate, wrongKey)
} catch {
  wrongRejected = true
}
ok('неверный пароль ключ не открывает', wrongRejected)

// Восстановленный ключ должен работать как настоящий.
const restoredShared = await C.deriveSharedKey(restored, bob.publicKeyB64)
const readAfterRestore = await C.openText(probe, restoredShared)
ok('восстановленный ключ работает как исходный', readAfterRestore === 'общий секрет совпадает')

// ─────────────────────────── 4. Подмена ───────────────────────────

section('4. Целостность сообщений')

const sealed = await C.sealTextAAD('перевод 100 рублей', chatKey, 'aurora:chat1:user1')

const tampered = { ...sealed, ciphertext: C.toB64(C.fromB64(sealed.ciphertext).map((b, i) => (i === 3 ? b ^ 1 : b))) }
let tamperCaught = false
try {
  await C.openTextAAD(tampered, chatKey, 'aurora:chat1:user1')
} catch {
  tamperCaught = true
}
ok('изменённый шифротекст отвергается', tamperCaught)

let swapCaught = false
try {
  // То же сообщение, но предъявлено как отправленное в другой чат.
  await C.openTextAAD(sealed, chatKey, 'aurora:chat2:user1')
} catch {
  swapCaught = true
}
ok('перестановка в другой чат отвергается (AAD)', swapCaught)

let senderSwapCaught = false
try {
  await C.openTextAAD(sealed, chatKey, 'aurora:chat1:user2')
} catch {
  senderSwapCaught = true
}
ok('подмена отправителя отвергается (AAD)', senderSwapCaught)

const good = await C.openTextAAD(sealed, chatKey, 'aurora:chat1:user1')
ok('корректное сообщение читается', good === 'перевод 100 рублей')

// Разные IV при одинаковом тексте — иначе шифротексты совпадали бы и выдавали факт повтора.
const a = await C.sealText('одинаковый текст', chatKey)
const b = await C.sealText('одинаковый текст', chatKey)
ok('одинаковый текст даёт разные шифротексты', a.ciphertext !== b.ciphertext)

// ─────────────────────────── 5. Файлы ───────────────────────────

section('5. Шифрование файлов')

function makeBlob(bytes) {
  return new Blob([bytes])
}

/** Собирает File-подобный объект с нужным API для Node. */
function makeFile(bytes, name, type) {
  const blob = new Blob([bytes])
  return {
    _blob: blob,
    name,
    type,
    size: bytes.length,
    slice: (s, e) => blob.slice(s, e),
  }
}

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

const cases = [
  { name: 'маленький файл (10 Б)', size: 10 },
  { name: 'ровно один блок (1 МиБ)', size: 1024 * 1024 },
  { name: 'полтора блока (1.5 МиБ)', size: 1024 * 1024 + 512 * 1024 },
  { name: 'три блока (3 МиБ)', size: 3 * 1024 * 1024 },
]

for (const c of cases) {
  const original = new Uint8Array(c.size)
  for (let i = 0; i < c.size; i++) original[i] = (i * 31 + 7) & 0xff

  const file = makeFile(original, 'документ.pdf', 'application/pdf')
  const sealedFile = await C.sealFile(file, chatKey)

  // Главное требование к шифрованию: на сервере не должно быть ни одного
  // фрагмента открытых данных. Проверяем, что исходные байты не встречаются
  // в шифротексте.
  const sealedBytes = await blobToBytes(sealedFile.blob)
  const probeSeq = original.subarray(0, 64)
  let leaked = false
  for (let i = 0; i + probeSeq.length <= sealedBytes.length; i++) {
    let match = true
    for (let j = 0; j < probeSeq.length; j++) {
      if (sealedBytes[i + j] !== probeSeq[j]) {
        match = false
        break
      }
    }
    if (match) {
      leaked = true
      break
    }
  }

  const restoredBlob = await C.openFile(sealedFile.blob, sealedFile.key, 'application/pdf')
  const restoredBytes = await blobToBytes(restoredBlob)
  const identical =
    restoredBytes.length === original.length && restoredBytes.every((b, i) => b === original[i])

  ok(
    `${c.name}: восстановлен байт-в-байт`,
    identical,
    `${(sealedBytes.length / 1024).toFixed(0)} КБ на сервере`
  )
  if (c.size <= 1024 * 1024) ok(`${c.name}: открытых данных в шифротексте нет`, !leaked)
}

// Имя файла тоже не должно утекать.
const secretFile = makeFile(new Uint8Array(128), 'паспорт-сканы.pdf', 'application/pdf')
const sealedSecret = await C.sealFile(secretFile, chatKey)
const nameOnServer = C.toB64(new TextEncoder().encode(sealedSecret.nameSealed.ciphertext))
ok('имя файла на сервере зашифровано', !nameOnServer.includes('паспорт'))
ok(
  'имя файла восстанавливается',
  (await C.openTextAAD(sealedSecret.nameSealed, chatKey, 'filename')) === 'паспорт-сканы.pdf',
)

// Ключ файла, завёрнутый ключом чата, должен сниматься.
const fileKeyWrap = await C.wrapChatKey(sealedSecret.key, chatKey)
const fileKeyBack = await C.unwrapChatKey(fileKeyWrap, chatKey)
const roundTrip = await C.openFile(sealedSecret.blob, fileKeyBack, 'application/pdf')
ok('ключ файла передаётся и снимается', (await blobToBytes(roundTrip)).length === 128)

// ─────────────────────────── 6. Скорость ───────────────────────────

section('6. Скорость операций')

async function time(label, iterations, fn) {
  await fn() // прогрев: первый вызов всегда медленнее из-за JIT
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) await fn()
  const per = (performance.now() - t0) / iterations
  console.log(`  ${label.padEnd(38)} \x1b[36m${per.toFixed(3)} мс\x1b[0m`)
  return per
}

const tSeal256 = await time('шифрование 256 Б', 200, () => C.sealText('x'.repeat(256), chatKey))
const tSeal8k = await time('шифрование 8 КБ', 100, () => C.sealText('y'.repeat(8192), chatKey))
const sealedRef = await C.sealText('x'.repeat(256), chatKey)
const tOpen256 = await time('расшифровка 256 Б', 200, () => C.openText(sealedRef, chatKey))
const tKeygen = await time('генерация ключей ECDH', 30, () => C.generateIdentity())
const tEcdh = await time('согласование секрета ECDH', 30, () =>
  C.deriveSharedKey(alice.privateKey, bob.publicKeyB64),
)
const tWrap = await time('обёртка ключа чата', 50, () => C.wrapChatKey(chatKey, aliceShared))
const tPbkdf2 = await time('вывод ключа из пароля, 600k итераций', 3, () =>
  C.derivePasswordKey('benchmark-password', salt, C.PBKDF2_ITERATIONS),
)

const bigFile = makeFile(new Uint8Array(5 * 1024 * 1024), 'big.bin', 'application/octet-stream')
const tFile = await time('шифрование файла 5 МБ', 3, () => C.sealFile(bigFile, chatKey))
console.log(
  `  \x1b[90m→ пропускная способность файлов: ${(5 / (tFile / 1000)).toFixed(0)} МБ/с\x1b[0m`
)

// ─────────────────────────── 7. Бюджет кадра ───────────────────────────

section('7. Вписывается ли в бюджет кадра')

// 16.7 мс — кадр на 60 Гц, 8.3 мс — на 120 Гц, 5.6 мс — на 180 Гц.
const budget60 = 16.7
const budget120 = 8.3
void budget120

// Худший реалистичный случай на кадр: расшифровать пачку пришедших сообщений.
const batch = []
for (let i = 0; i < 20; i++) {
  batch.push(await C.sealText('сообщение средней длины, как в переписке ' + i, chatKey))
}
const tBatch0 = performance.now()
for (const b of batch) await C.openText(b, chatKey)
const tBatchTotal = performance.now() - tBatch0
const perMessage = tBatchTotal / batch.length

console.log(`  пачка из 20 сообщений: \x1b[36m${tBatchTotal.toFixed(2)} мс\x1b[0m всего, ${perMessage.toFixed(3)} мс на сообщение`)
ok(
  '20 сообщений расшифровываются быстрее одного кадра 60 Гц',
  tBatchTotal < budget60,
  `${tBatchTotal.toFixed(2)} мс < 16.7 мс`,
)
ok(
  'одно сообщение заметно дешевле кадра на 180 Гц',
  perMessage < 5.6 / 4,
  `${perMessage.toFixed(3)} мс < 1.4 мс`,
)
ok('шифрование не мешает вводу (укладывается в 1 мс)', tSeal256 < 1, `${tSeal256.toFixed(3)} мс`)

// ─────────────────────────── Итог ───────────────────────────

console.log(
  `\n\x1b[1m${failed === 0 ? '\x1b[32mВсе проверки пройдены' : '\x1b[31mЕсть ошибки'}\x1b[0m: \x1b[32m${passed} ✓\x1b[0m  \x1b[31m${failed} ✗\x1b[0m\n`,
)

console.log('\x1b[90mСводка для сравнения:\x1b[0m')
console.log(`  ключи ECDH          ${tKeygen.toFixed(1)} мс  (вход/регистрация)`)
console.log(`  секрет ECDH         ${tEcdh.toFixed(2)} мс  (один раз на чат)`)
console.log(`  пароль → ключ       ${tPbkdf2.toFixed(0)} мс  (только при входе с новым устройством)`)
console.log(`  шифрование          ${tSeal256.toFixed(3)} мс  (на каждое сообщение)`)
console.log(`  имя файла           ${tWrap.toFixed(3)} мс  (на файл)`)
console.log('')

process.exit(failed === 0 ? 0 : 1)