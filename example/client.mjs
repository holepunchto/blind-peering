import Hyperdht from 'hyperdht'
import Corestore from 'corestore'
import BlindPeering from '../index.js'

const node = new Hyperdht()
const store = new Corestore('/tmp/bps-client')
const b = new BlindPeering(node, store, {
  keys: [Buffer.from('ce4fd848761142ee3079e1d97736d6871525050e566ecc58e4f218de534843cc', 'hex')]
})

const core1 = store.get({ name: 'testing1' })
await core1.ready()

// const core2 = store.get({ name: 'testing2' })
// await core2.ready()

b.addCore(core1)
// b.addCore(core2)

core1.on('upload', function (index) {
  console.log('uploading...', index)
})

// setTimeout(async () => {
//   const b = []
//   // while (b.length < 100_000) b.push(Buffer.from('tick'))
//   // await core1.append(b)

//   console.log(core1)

//   core1.close()
//   // core2.close()
//   console.log('closing...')
// }, 4_000)
