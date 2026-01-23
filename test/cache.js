const createTestnet = require('hyperdht/testnet')
const BlindPeer = require('blind-peer')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const test = require('brittle')
const BlindPeering = require('..')

const { encode, decode } = require('../spec/hyperschema')

test('uses cache', async (t) => {
  const testnet = await createTestnet()
  const storage = await tmp(t)
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const store = new Corestore(storage)
  swarm.on('connection', (c) => {
    console.log('connection opened')
    store.replicate(c)
  })

  t.teardown(async () => {
    await swarm.destroy()
    await store.close()
    await testnet.destroy()
  })

  t.pass('setup')

  const { blindPeer } = await createTestBlindPeer(t, testnet.bootstrap, {
    debug: true,
    trustedPubKeys: [swarm.dht.defaultKeyPair.publicKey]
  })
  await blindPeer.listen()
  await blindPeer.swarm.flush()

  const core = store.get({ name: 'core' })
  await core.append('Block 0')
  await core.append('Block 1')
  await core.append('Block 2')
  const discovery = swarm.join(core.discoveryKey)
  await discovery.flushed()
  const coreKey = core.key

  const q = swarm.dht.findPeer(blindPeer.publicKey)
  const nodes = []
  for await (const d of q) {
    nodes.push({ host: d.from.host, port: d.from.port })
  }
  console.log(nodes)

  const blindPeerKey = encode('@blind-peering/blind-peer-key', {
    key: blindPeer.publicKey,
    nodes
  })

  const client = new BlindPeering(swarm, store, { mediaMirrors: [blindPeerKey] })
  client.addCoreBackground(core, coreKey, { announce: true })
  t.pass('added core')

  await new Promise((res) => setTimeout(res, 3000))

  await client.close()
  await swarm.destroy()

  t.pass('closed')

  {
    const storage = await tmp(t)
    const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
    const store = new Corestore(storage)
    swarm.on('connection', (c) => {
      console.log('connection opened')
      store.replicate(c)
    })

    t.teardown(async () => {
      await swarm.destroy()
      await store.close()
      await testnet.destroy()
    })

    const core = store.get({ key: coreKey })
    await new Promise((res) => setTimeout(res, 4000))
    console.log(core)
  }
})

async function createTestBlindPeer(
  t,
  bootstrap,
  { storage, maxBytes, enableGc, trustedPubKeys, debug, order } = {}
) {
  if (!storage) storage = await tmp(t)

  const swarm = new Hyperswarm({ bootstrap })
  const peer = new BlindPeer(storage, {
    swarm,
    maxBytes,
    enableGc,
    trustedPubKeys
  })

  t.teardown(
    async () => {
      await peer.close()
      await swarm.destroy()
    },
    { order }
  )

  await peer.listen()
  if (debug) {
    peer.swarm.on('connection', () => {
      console.log('Blind peer connection opened')
    })
  }

  return { blindPeer: peer, storage }
}
