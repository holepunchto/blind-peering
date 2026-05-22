const test = require('brittle')
const setupTestnet = require('hyperdht/testnet')
const Corestore = require('corestore')
const { once } = require('events')
const Hyperswarm = require('hyperswarm')
const BlindPeer = require('blind-peer')
const BlindPeering = require('..')

test('addCore happy path', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await setupBlindPeer(t, bootstrap)
  const { core, swarm, store } = await setupCoreHolder(t, bootstrap)

  const client = new BlindPeering(swarm.dht, store, { keys: [blindPeer.publicKey] })
  t.teardown(() => client.close())

  const [, [record]] = await Promise.all([client.addCore(core), once(blindPeer, 'add-core')])
  t.alike(record.key, core.key, 'blind-peer received the core key')
  t.is(record.priority, 0, 'uses the default priority')
  t.is(record.announce, false, 'does not announce by default')
  t.is(client.stats.addCore, 1, 'tracks one addCore')
  t.is(client.stats.addCoresTx, 1, 'sends one addCores request')
})

test('addCore dedups repeated adds', async (t) => {
  const { bootstrap } = await getTestnet(t)
  const { blindPeer } = await setupBlindPeer(t, bootstrap)
  const { core, swarm, store } = await setupCoreHolder(t, bootstrap)

  const client = new BlindPeering(swarm.dht, store, { keys: [blindPeer.publicKey] })
  t.teardown(() => client.close())

  await client.addCore(core)
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(client.stats.addCore, 1, 'one add')
  t.is(client.stats.addCoresTx, 1, 'one tx')
  t.is(blindPeer.stats.addCoresRx, 1, 'one rx')
  t.is(blindPeer.stats.activations, 1, 'one activation')

  await client.addCore(core)
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(client.stats.addCore, 1, 'dedups active add')
  t.is(client.stats.addCoresTx, 1, 'no duplicate tx')
  t.is(blindPeer.stats.addCoresRx, 1, 'no duplicate rx')
  t.is(blindPeer.stats.activations, 1, 'no duplicate activation')

  // simulate reconnect
  await client.suspend()
  await client.resume()

  await client.addCore(core)
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(client.stats.addCore, 2, 're-adds after reconnect')
  t.is(client.stats.addCoresTx, 2, 'reconnect tx')
  t.is(blindPeer.stats.addCoresRx, 2, 'reconnect rx')
  t.is(blindPeer.stats.activations, 1, 'activation unchanged')

  await core.append('additional block')

  await client.addCore(core)
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(client.stats.addCore, 3, 'adds changed core')
  t.is(client.stats.addCoresTx, 3, 'changed core tx')
  t.is(blindPeer.stats.addCoresRx, 3, 'changed core rx')
  t.is(blindPeer.stats.activations, 2, 'new activation')
})

async function setupCoreHolder(t, bootstrap) {
  const { swarm, store } = await setupPeer(t, bootstrap)

  const core = store.get({ name: 'core' })
  await core.append('Block 0')
  await core.append('Block 1')
  swarm.join(core.discoveryKey)

  return { swarm, store, core }
}

async function setupBlindPeer(t, bootstrap) {
  const storage = await t.tmp()
  const blindPeer = new BlindPeer(storage, {
    bootstrap,
    wakeupGcTickTime: 100
  })

  t.teardown(() => blindPeer.close())

  await blindPeer.listen()
  await blindPeer.swarm.flush()

  return { blindPeer }
}

async function setupPeer(t, bootstrap) {
  const storage = await t.tmp()
  const swarm = new Hyperswarm({ bootstrap })
  const store = new Corestore(storage, { active: false })

  swarm.on('connection', (stream) => {
    store.replicate(stream)
  })

  t.teardown(async () => {
    await swarm.destroy()
    await store.close()
  })

  return { swarm, store }
}

async function getTestnet(t) {
  const testnet = await setupTestnet()
  t.teardown(() => testnet.destroy(), { order: Infinity })

  return testnet
}
