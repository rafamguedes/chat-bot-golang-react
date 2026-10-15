import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readEvents } from '../src/lib/sse.mjs'

function stream(chunks) {
  return new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close() } })
}
const encode = text => new TextEncoder().encode(text)

test('SSE survives every possible UTF-8 byte boundary', async () => {
  const bytes = encode('data: {"type":"delta","delta":"Olá 🌱"}\r\n\r\ndata: {"type":"done"}\r\n\r\n')
  for (let i = 1; i < bytes.length; i++) {
    const events = []
    for await (const event of readEvents(stream([bytes.slice(0,i),bytes.slice(i)]))) events.push(event)
    assert.deepEqual(events,[{type:'delta',delta:'Olá 🌱'},{type:'done'}])
  }
})
test('multiline data, comments and trailing event without newline', async () => {
  const events = []
  for await (const event of readEvents(stream([encode(': heartbeat\nevent: delta\ndata: {"type":"delta",\ndata: "delta":"oi"}\n\ndata: {"type":"done"}')]))) events.push(event)
  assert.deepEqual(events,[{type:'delta',delta:'oi'},{type:'done'}])
})
test('malformed event fails instead of silently succeeding', async () => {
  await assert.rejects(async () => { for await (const _event of readEvents(stream([encode('data: broken\n\n')]))) {} }, SyntaxError)
})
test('stopping consumption cancels the reader', async () => {
  let canceled = false
  const body = new ReadableStream({start(controller){controller.enqueue(encode('data: {"type":"done"}\n\n'))},cancel(){canceled=true}})
  for await (const _event of readEvents(body)) break
  assert.equal(canceled,true)
})
