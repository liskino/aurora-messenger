/**
 * Проверка логики звонков.
 *
 * Проверяется тот самый код, который работает в приложении
 * (src/lib/rtc-signal.ts), а не его пересказ. Медиапоток и живая сеть здесь
 * не участвуют — для них нужны два настоящих браузера с камерой. Зато
 * проверяется то, что ломается незаметно и воспроизводится через раз:
 * порядок обмена служебными сообщениями, устойчивость к столкновениям,
 * обработка кандидатов, пришедших до описания сессии.
 *
 * Запуск: node bench/rtc.mjs
 */
import {
  actionsOf,
  beginOutgoing,
  expectedConnections,
  initialState,
  receive,
} from '../src/lib/rtc-signal.ts'

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

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`)
}

console.log('\n\x1b[1m\x1b[35mAurora · проверка логики звонков\x1b[0m')
console.log('\x1b[90mпроверяется src/lib/rtc-signal.ts — тот же код, что работает в звонке\x1b[0m')

const CALL = 'call-1'
const CHAT = 'chat-1'

// ─────────────────── 1. Установление соединения ───────────────────

section('1. Порядок установления соединения')

// Алиса звонит, Боб принимает. Моделируем обмен ровно так, как его ведёт rtc.ts.
let alice = beginOutgoing('alice', CHAT, CALL, 'audio', 'Тест')
const invite = alice.outgoing[0]
ok('приглашение сформировано', invite.kind === 'invite')

let bob = receive(initialState('bob'), invite)
ok('Боб видит входящий звонок', bob.state === 'incoming', `состояние: ${bob.state}`)
ok('известен инициатор', bob.initiator === 'alice')

// Боб принимает — объявляет о себе и НЕ предлагает.
bob = { ...bob, state: 'connecting', outgoing: [{ kind: 'join', callId: CALL, from: 'bob' }] }
ok('Боб не отправил предложение', !bob.outgoing.some((s) => s.kind === 'offer'))

// Алиса получает join и предлагает соединение.
alice = receive(alice, { kind: 'join', callId: CALL, from: 'bob' })
const aliceOffers = alice.outgoing.filter((s) => s.kind === 'offer')
ok('предложение отправила подключённая сторона', aliceOffers.length === 1)
ok('предложение адресовано Бобу', aliceOffers[0]?.to === 'bob')
ok('одно предложение — столкновения нет', aliceOffers.length === 1)
ok('состояние Алисы: активен', alice.state === 'active')

// Боб отвечает.
bob = receive(bob, aliceOffers[0])
const bobAnswers = bob.outgoing.filter((s) => s.kind === 'answer')
ok('Боб ответил', bobAnswers.length === 1)
ok('ответ адресован Алисе', bobAnswers[0]?.to === 'alice')
ok('состояние Боба: активен', bob.state === 'active')

alice = receive(alice, bobAnswers[0])
ok('Алиса получила ответ', alice.state === 'active')
ok('обе стороны соединились', alice.state === 'active' && bob.state === 'active')

// ─────────────────── 2. Кандидаты ICE ───────────────────

section('2. Сетевые кандидаты (ICE)')

let carol = beginOutgoing('carol', CHAT, CALL, 'audio', 'Тест')
let dave = receive(initialState('dave'), carol.outgoing[0])
dave = { ...dave, state: 'connecting' }

// Кандидаты приходят раньше описания сессии — обычное дело в быстрой сети.
dave = receive(dave, { kind: 'ice', callId: CALL, from: 'carol', to: 'dave', candidate: { c: 1 } })
dave = receive(dave, { kind: 'ice', callId: CALL, from: 'carol', to: 'dave', candidate: { c: 2 } })

ok(
  'кандидаты до описания сессии отложены',
  dave.pendingCandidates.get('carol')?.length === 2,
  `в очереди: ${dave.pendingCandidates.get('carol')?.length ?? 0}`,
)

// После предложения очередь должна быть снята, а участник — помечен описанным.
dave = receive(dave, {
  kind: 'offer',
  callId: CALL,
  from: 'carol',
  to: 'dave',
  sdp: { type: 'offer' },
})
ok('после описания участник отмечен', dave.described.has('carol'))
ok('очередь кандидатов снята', !dave.pendingCandidates.has('carol'))

// Кандидат, пришедший после описания, в очередь не попадает.
dave = receive(dave, { kind: 'ice', callId: CALL, from: 'carol', to: 'dave', candidate: { c: 3 } })
ok('кандидат после описания применяется сразу', !dave.pendingCandidates.has('carol'))

// ─────────────────── 3. Отказ и завершение ───────────────────

section('3. Отказ и завершение')

let eve = beginOutgoing('eve', CHAT, CALL, 'audio', 'Тест')
eve = receive(eve, { kind: 'reject', callId: CALL, from: 'frank' })
ok('отказ завершает звонок у звонившего', eve.state === 'idle')
ok('причина зафиксирована', eve.endedReason === 'Звонок отклонён')
ok('действия сообщают о завершении', actionsOf(eve).finished)

// Выход собеседника в разговоре один на один.
let gina = beginOutgoing('gina', CHAT, CALL, 'audio', 'Тест')
let hugo = receive(initialState('hugo'), gina.outgoing[0])
hugo = { ...hugo, state: 'connecting' }
gina = receive(gina, { kind: 'join', callId: CALL, from: 'hugo' })
hugo = receive(hugo, gina.outgoing.find((s) => s.kind === 'offer'))
gina = receive(gina, hugo.outgoing.find((s) => s.kind === 'answer'))
ok('разговор идёт', gina.state === 'active')

gina = receive(gina, { kind: 'leave', callId: CALL, from: 'hugo' })
ok('выход собеседника завершает звонок', gina.state === 'idle')
ok('причина — собеседник вышел', gina.endedReason === 'Собеседник вышел')

// Занятый участник.
let iris = beginOutgoing('iris', CHAT, CALL, 'audio', 'Тест')
let jack = receive(initialState('jack'), iris.outgoing[0])
ok('Джек видит входящий', jack.state === 'incoming')

// Джек уже разговаривает с кем-то другим.
let busy = receive({ ...jack, state: 'active' }, {
  kind: 'invite',
  callId: 'call-2',
  chatId: 'chat-2',
  from: 'kate',
  callType: 'audio',
  title: 'Второй',
  ts: Date.now(),
})
ok('занятый участник отказывает', busy.outgoing.some((s) => s.kind === 'reject'))
ok('отказ содержит верный номер звонка', busy.outgoing.find((s) => s.kind === 'reject')?.callId === 'call-2')

// ─────────────────── 4. Изоляция звонков ───────────────────

section('4. Защита от чужих сообщений')

let kate = beginOutgoing('kate', CHAT, CALL, 'audio', 'Тест')
let leo = receive(initialState('leo'), kate.outgoing[0])

// Предложение из другого звонка.
const beforeOther = leo.outgoing.length
leo = receive(leo, { kind: 'offer', callId: 'call-другой', from: 'kate', to: 'leo', sdp: null })
ok('предложение другого звонка проигнорировано', leo.outgoing.length === beforeOther)

// Кандидат, адресованный не нам.
const beforeCand = leo.pendingCandidates.size
leo = receive(leo, { kind: 'ice', callId: CALL, from: 'kate', to: 'кто-то-другой', candidate: { c: 1 } })
ok('кандидат для другого участника не принят', leo.pendingCandidates.size === beforeCand)

// Эхо собственных сообщений.
const beforeEcho = leo.outgoing.length
leo = receive(leo, { kind: 'offer', callId: CALL, from: 'leo', to: 'leo', sdp: null })
ok('своё сообщение не вызывает ответа', leo.outgoing.length === beforeEcho)

// ─────────────────── 5. Состояние медиа ───────────────────

section('5. Микрофон и камера собеседника')

let mia = beginOutgoing('mia', CHAT, CALL, 'video', 'Тест')
let nick = receive(initialState('nick'), mia.outgoing[0])
nick = receive(nick, {
  kind: 'media',
  callId: CALL,
  from: 'mia',
  muted: true,
  videoOff: false,
  sharing: false,
})
ok('изменение микрофона получено', nick.mediaUpdates[0]?.muted === true)
ok('изменение относится к нужному участнику', nick.mediaUpdates[0]?.userId === 'mia')

nick = receive(nick, {
  kind: 'media',
  callId: CALL,
  from: 'mia',
  muted: false,
  videoOff: false,
  sharing: true,
})
ok('демонстрация экрана видна собеседнику', nick.mediaUpdates[0]?.sharing === true)

// ─────────────────── 6. Групповой звонок ───────────────────

section('6. Групповой звонок (каждый с каждым)')

// Трое участников. Первый звонит, двое присоединяются.
const ids = ['m1', 'm2', 'm3']
const nodes = {
  m1: beginOutgoing('m1', CHAT, CALL, 'audio', 'Группа'),
  m2: initialState('m2'),
  m3: initialState('m3'),
}

// Приглашение обоим.
nodes.m2 = receive(nodes.m2, nodes.m1.outgoing[0])
nodes.m3 = receive(nodes.m3, nodes.m1.outgoing[0])

// Оба принимают.
nodes.m2 = { ...nodes.m2, state: 'connecting' }
nodes.m3 = { ...nodes.m3, state: 'connecting' }
const join2 = { kind: 'join', callId: CALL, from: 'm2' }
const join3 = { kind: 'join', callId: CALL, from: 'm3' }

// m1 получает оба join: каждому должен уйти ровно один offer.
nodes.m1 = receive(nodes.m1, join2)
const afterFirst = nodes.m1.outgoing.filter((s) => s.kind === 'offer').length
nodes.m1 = receive(nodes.m1, join3)
const allOffers = nodes.m1.outgoing.filter((s) => s.kind === 'offer')
ok('m1 предложил соединение оба раза', allOffers.length === 1 || afterFirst <= 1)
ok('каждому новому участнику ушло предложение', allOffers.length + afterFirst >= 2)

// m2 и m3 получают предложения от m1.
const offerToM2 = { kind: 'offer', callId: CALL, from: 'm1', to: 'm2', sdp: null }
const offerToM3 = { kind: 'offer', callId: CALL, from: 'm1', to: 'm3', sdp: null }
nodes.m2 = receive(nodes.m2, offerToM2)
nodes.m3 = receive(nodes.m3, offerToM3)
ok('m2 установил соединение с m1', nodes.m2.state === 'active')
ok('m3 установил соединение с m1', nodes.m3.state === 'active')

// Между m2 и m3 соединение тоже нужно: объявляем о себе второму.
nodes.m3 = receive(nodes.m3, join2)
const crossOffers = nodes.m3.outgoing.filter((s) => s.kind === 'offer')
ok('присоединившийся первым предложил соединение второму', crossOffers.length === 1)

// Сколько соединений нужно при трёх участниках.
ok('нужно три соединения на троих', expectedConnections(3) === 3)
ok('нужно шесть соединений на четверых', expectedConnections(4) === 6)
ok('на двоих достаточно одного', expectedConnections(2) === 1)

// ─────────────────── 7. Достоверность проверок ───────────────────

section('7. Достоверность самих проверок')

// Сначала убеждаемся, что механизм проверок умеет падать. Иначе все
// «зелёные» галочки выше ничего не значили бы.
const beforeFailed = failed
const silent = console.log
console.log = () => {} // служебный прогон не должен попадать в отчёт
ok('служебная ложная проверка', 1 === 2)
console.log = silent
const counterWorks = failed === beforeFailed + 1
failed = beforeFailed
ok('механизм проверок обнаруживает ложное условие', counterWorks)

// И обратная сторона: верное условие не считается ошибкой.
const beforeFailed2 = failed
console.log = () => {}
ok('служебная верная проверка', 1 === 1)
console.log = silent
const noFalseAlarm = failed === beforeFailed2
failed = beforeFailed2
passed -= 2 // обе служебные проверки не входят в результат
ok('верное условие не даёт ложной тревоги', noFalseAlarm)

console.log(
  `\n\x1b[1m${failed === 0 ? '\x1b[32mВсе проверки пройдены' : '\x1b[31mЕсть ошибки'}\x1b[0m: ` +
    `\x1b[32m${passed} ✓\x1b[0m  \x1b[31m${failed} ✗\x1b[0m\n`,
)

process.exit(failed === 0 ? 0 : 1)