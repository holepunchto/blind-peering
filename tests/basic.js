const test = require('brittle')
const HyperDHTAddress = require('hyperdht-address')
const b4a = require('b4a')
const os = require('os')
const HyperDHT = require('hyperdht')
const crypto = require('hypercore-crypto')
const {
  setupCoreHolder,
  initBlindPeer,
  initBlindPeers,
  getTestnet,
  setupPeer,
  waitUntil,
  waitUntilStoredOn,
  waitForCoresDownloaded,
  sleep,
  createClient
} = require('./helpers')

test('addCore throws on invalid blindPeers', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store)
  await t.exception.all(client.addCore(core, null))
})

test('addCore tracks correct blindPeers', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const blindPeers = await initBlindPeers(t, bootstrap, 3)
  const keys = blindPeers.map((x) => x.publicKey)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store)

  await client.addCore(core, [
    keys[0], // [0] just public key
    HyperDHTAddress.encode(keys[1], bootstrap), // [1] just HyperDHTAddress
    keys[2], // [2] public key and HyperDHTAddress
    HyperDHTAddress.encode(keys[2], bootstrap)
  ])

  t.is(client.blindPeers.size, 3, '3 blind peers were added')
})

test('can add a core', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store)
  await client.addCore(core, [blindPeer.publicKey])

  const record = await blindPeer.db.getCoreRecord(core.key)
  t.alike(record.key, core.key, 'added the core')
  t.is(record.priority, 0, 'default priority')
  t.is(record.announce, false, 'default no announce')
})

test('addCore stores the blind peer response', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store)
  await client.addCore(core, [blindPeer.publicKey])

  const peer = client.blindPeers.get(b4a.toString(blindPeer.publicKey, 'hex'))
  const info = peer.cores.get(b4a.toString(core.key, 'hex'))
  t.alike(
    info.response,
    { connection: peer.connects, length: 0, activated: true },
    'new core: blind peer had nothing and activated it'
  )
})

test('added core can be downloaded from the blind peer', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)
  const coreKey = core.key

  const client = createClient(t, swarm.dht, store)
  await client.addCore(core, [blindPeer.publicKey])

  await waitForCoresDownloaded(blindPeer, [core])
  await swarm.destroy() // so the core holder stops announcing the core

  const reader = await setupPeer(t, bootstrap)
  const readerCore = reader.store.get({ key: coreKey })
  await readerCore.ready()
  reader.swarm.joinPeer(blindPeer.publicKey, { dht: reader.swarm.dht })
  await waitUntil(t, () => readerCore.peers.length > 0, 'connected to the blind peer')

  t.is(b4a.toString(await readerCore.get(1)), 'Block 1', 'downloaded from the blind peer')
})

test('addCore adds to every given blind peer', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const blindPeers = await initBlindPeers(t, bootstrap, 3)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store)
  await client.addCore(
    core,
    blindPeers.map((x) => x.publicKey)
  )

  await waitUntilStoredOn(t, blindPeers, core, 3)
  t.pass('stored on all blind peers')
})

test('repeated addCore sends once', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store)
  await Promise.all([
    client.addCore(core, [blindPeer.publicKey]),
    client.addCore(core, [blindPeer.publicKey])
  ])
  await client.addCore(core, [blindPeer.publicKey])

  const peer = client.blindPeers.get(b4a.toString(blindPeer.publicKey, 'hex'))
  t.is(peer.cores.size, 1, 'one entry')
  t.is(client.stats.addCore, 1, 'one add')
  t.is(client.stats.addCoresTx, 1, 'one tx')
  t.is(blindPeer.stats.addCoresRx, 1, 'one rx')
})

test('multiple addCore before connecting are all sent once connected', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)
  const core2 = store.get({ name: 'core2' })
  const core3 = store.get({ name: 'core3' })
  await core2.append('block')
  await core3.append('block')

  const client = createClient(t, swarm.dht, store)
  await Promise.all([core, core2, core3].map((c) => client.addCore(c, [blindPeer.publicKey])))

  const peer = client.blindPeers.get(b4a.toString(blindPeer.publicKey, 'hex'))
  t.is(peer.connects, 1, 'one connection')
  t.is(client.stats.addCoresTx, 3, 'one tx per core')
  t.is(blindPeer.stats.addCoresRx, 3, 'blind peer received all')
})

test('addCore in flight when the connection drops is sent again on reconnect', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  let dropped = false
  blindPeer.on('add-cores-received', (stream) => {
    if (dropped) return
    dropped = true
    stream.destroy()
  })

  const client = createClient(t, swarm.dht, store)
  await client.addCore(core, [blindPeer.publicKey])

  const peer = client.blindPeers.get(b4a.toString(blindPeer.publicKey, 'hex'))
  t.ok(dropped, 'first connection was dropped mid-request')
  t.is(peer.connects, 2, 'reconnected once')
  t.is(client.stats.addCoresTx, 2, 'sent again on the new connection')
})

test('addCore retries on the same connection when rate limited', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const onaddcores = blindPeer._onaddcores.bind(blindPeer)
  let limited = false
  blindPeer._onaddcores = async (stream, request) => {
    if (!limited) {
      limited = true
      const err = new Error('rate limited')
      err.code = 'RATE_LIMITED'
      throw err
    }
    return onaddcores(stream, request)
  }

  const client = createClient(t, swarm.dht, store)
  await client.addCore(core, [blindPeer.publicKey])

  const peer = client.blindPeers.get(b4a.toString(blindPeer.publicKey, 'hex'))
  t.ok(limited, 'first request was rate limited')
  t.is(peer.connects, 1, 'same connection')
  t.is(client.stats.addCoresTx, 2, 'sent again after the rate limit')
  t.ok(await blindPeer.db.getCoreRecord(core.key), 'accepted by the blind peer')
})

test('addCore while suspended stays pending and resolves after resume', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const client = createClient(t, swarm.dht, store, { suspended: true })
  let settled = false
  const adding = client.addCore(core, [blindPeer.publicKey]).finally(() => {
    settled = true
  })

  await sleep(500)
  t.is(settled, false, 'still pending while suspended')
  t.is(blindPeer.stats.addCoresRx, 0, 'nothing sent while suspended')

  await client.resume()
  await adding
  t.ok(await blindPeer.db.getCoreRecord(core.key), 'accepted after resume')
})

test('suspend while a request is in flight does not reject, resume re-sends', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  const { swarm, store, core } = await setupCoreHolder(t, bootstrap)

  const onaddcores = blindPeer._onaddcores.bind(blindPeer)
  let received = null
  const firstReceived = new Promise((resolve) => (received = resolve))
  let first = true
  blindPeer._onaddcores = async (stream, request) => {
    if (first) {
      first = false
      received()
      await new Promise(() => {}) // never answers the first request
    }
    return onaddcores(stream, request)
  }

  const client = createClient(t, swarm.dht, store)
  let settled = false
  const adding = client.addCore(core, [blindPeer.publicKey]).finally(() => {
    settled = true
  })

  await firstReceived
  await client.suspend()
  await sleep(200)
  t.is(settled, false, 'still pending after suspend')

  await client.resume()
  await adding
  t.is(client.stats.addCoresTx, 2, 're-sent after resume')
  t.ok(await blindPeer.db.getCoreRecord(core.key), 'accepted after resume')
})

test('destroying the dht closes blind-peering and rejects pending adds', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { store, core } = await setupCoreHolder(t, bootstrap)
  const dht = new HyperDHT({ bootstrap })

  const client = createClient(t, dht, store)
  const unreachable = crypto.keyPair().publicKey
  const adding = client.addCore(core, [unreachable])

  await sleep(200)
  await dht.destroy()

  await t.exception(adding, 'pending add rejected')
  t.is(client.closed, true, 'blind-peering closed')
})

test('client sends handshake', async (t) => {
  t.plan(4)
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await initBlindPeer(t, bootstrap)
  blindPeer.on('add-core', (_, __, stream) => {
    const handshake = stream.userData.getLastChannel({ protocol: 'blind-peer' }).handshake
    t.is(typeof handshake?.blindPeeringVersion, 'string')
    t.is(handshake?.clientName, 'app')
    t.is(handshake?.clientVersion, '3.2.1')
    t.is(handshake?.osPlatform, os.platform())
  })

  const { core, swarm, store } = await setupCoreHolder(t, bootstrap)
  const client = createClient(t, swarm.dht, store, { client: { name: 'app', version: '3.2.1' } })
  await client.addCore(core, [blindPeer.publicKey])
})
