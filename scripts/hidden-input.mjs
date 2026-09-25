// Lines of a stdin that isn't a terminal (e.g. piped input), read once and
// handed out one per prompt
let pipedLines = null

function readPipedLine() {
  if (!pipedLines) {
    pipedLines = new Promise((resolve) => {
      let data = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => (data += chunk))
      process.stdin.on('end', () => resolve(data.split(/\r?\n/)))
    })
  }

  return pipedLines.then((lines) => lines.shift() ?? '')
}

// Reads a line without echoing it, for NPSSOs and admin tokens. Falls back to
// a plain line read when stdin isn't a terminal. Resolves with null on Ctrl+C.
export function askHidden(question) {
  process.stdout.write(question)

  const stdin = process.stdin

  if (!stdin.isTTY) {
    return readPipedLine().then((line) => {
      process.stdout.write('\n')
      return line
    })
  }

  return new Promise((resolve) => {
    let value = ''

    const finish = (result) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      resolve(result)
    }

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish(value)
          return
        }

        if (char === '\u0003') {
          finish(null) // Ctrl+C
          return
        }

        if (char === '\u0008' || char === '\u007f') {
          value = value.slice(0, -1)
        } else {
          value += char
        }
      }
    }

    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}
