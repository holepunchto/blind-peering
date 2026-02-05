import Hyperdht from 'hyperdht'
import BlindPeerMuxer from 'blind-peer-muxer'
import Corestore from 'corestore'

const node = new Hyperdht()
const store = new Corestore('/tmp/bps-server')

const server = node.createServer(function (socket) {
  store.replicate(socket)
  BlindPeerMuxer.pair(socket, function () {
    new BlindPeerMuxer(socket, {
      async oncores(data) {
        console.log('-->', data)

        for (const { key } of data.cores) {
          const core = store.get(key)
          await core.ready()
          console.log('opened', core, 'downloading', core.contiguousLength)
          core.on('download', function (index) {
            console.log('dl', index)
          })
          core.on('append', function () {
            console.log('appended!', core.length)
          })
          core.download()
        }
      }
    })
  })
})

await server.listen(Hyperdht.keyPair(Buffer.alloc(32, 'mafi')))

console.log(server.address().publicKey.toString('hex'))
