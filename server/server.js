// test-server.js (プロジェクトのルート、または server/test-server.js として一時的に作成)
const http = require('http')

const port = process.env.PORT || 8080 // デフォルトはわざと別のポート(10000以外)に

console.log(`[TestServer] process.env.PORT の値: ${process.env.PORT}`)
console.log(`[TestServer] サーバーが使用するポート: ${port}`)

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(
    `Test Server OK. Listening on port ${port}. process.env.PORT was ${process.env.PORT}\n`
  )
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[TestServer] Server is running on http://0.0.0.0:${port}`)
})
