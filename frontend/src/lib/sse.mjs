/** Decode SSE without assuming a network chunk is a complete event or UTF-8 character.
 * @param {ReadableStream<Uint8Array>} body
 */
export async function* readEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let lines = []
  const parseLine = (line) => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') {
      if (!lines.length) return null
      const data = JSON.parse(lines.join('\n'))
      lines = []
      return data
    }
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
    return null
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = pending.indexOf('\n')) !== -1) {
        const event = parseLine(pending.slice(0, boundary))
        pending = pending.slice(boundary + 1)
        if (event) yield event
      }
      if (done) {
        if (pending) parseLine(pending)
        const last = parseLine('')
        if (last) yield last
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
